/*
 * Auto top-up: when someone's balance falls below a level they pick, Flash buys the credit pack
 * they picked with the card they saved, so a long build never stops for credits. Each top-up is
 * an ordinary pack at its usual price (and margin), and it is held back by:
 * - at most MAX_PER_MONTH top-ups a calendar month, and none within GAP_MINUTES of the last one;
 * - nothing for an account that disputed a payment;
 * - a declined card or one that needs the person (3-D Secure) turns auto top-up off, and the
 *   reason is shown in Credits until they turn it on again.
 * With FLASH_STRIPE_TAX on, Stripe Tax works out the tax from the card's billing address and it is
 * added on top, as at checkout.
 */
import { CREDIT_PACKS } from "../credits.ts";
import { addPurchase, disputed, topUpBalance } from "./credits.ts";
import { one, run, now } from "./db.ts";
import { currency, paymentsEnabled, stripe, taxOn } from "./stripe.ts";
import { checkLowBalance } from "./low-balance.ts";

export const MAX_PER_MONTH = 4;
const GAP_MINUTES = 10;
// The levels a person can pick for "when my balance falls below".
export const TOP_UP_LEVELS = [100, 300, 1000] as const;

type Row = {
  user_id: string;
  enabled: number;
  pack: string;
  below: number;
  customer: string | null;
  payment_method: string | null;
  last_at: number;
  failed: string;
};

export type AutoTopUp = {
  enabled: boolean;
  pack: string;
  below: number;
  // A card is saved for top-ups.
  card: boolean;
  // Why the last top-up didn't go through, until auto top-up is turned on again.
  failed: string;
  thisMonth: number;
  maxPerMonth: number;
};

const monthStart = (t = new Date()) => Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);

const topUpsThisMonth = async (userId: string) =>
  Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ? AND ref LIKE 'stripe:auto:%' AND created_at >= ?", [userId, monthStart()]))?.n ?? 0);

/** What the person set, for Credits. */
export async function autoTopUp(userId: string): Promise<AutoTopUp> {
  const row = await one<Row>("SELECT * FROM auto_topups WHERE user_id = ?", [userId]);
  return {
    enabled: Boolean(row?.enabled),
    pack: row?.pack ?? CREDIT_PACKS[0].id,
    below: Number(row?.below ?? TOP_UP_LEVELS[0]),
    card: Boolean(row?.payment_method),
    failed: row?.failed ?? "",
    thisMonth: await topUpsThisMonth(userId),
    maxPerMonth: MAX_PER_MONTH,
  };
}

/**
 * Saves the person's choice. Turning it on without a saved card returns a Stripe page where they
 * save one (the webhook keeps it, see saveCard); it is on once that is done.
 */
export async function setAutoTopUp(
  user: { id: string; email: string },
  choice: { enabled: boolean; pack: string; below: number },
  origin: string,
): Promise<{ url?: string; error?: string }> {
  if (!CREDIT_PACKS.some((p) => p.id === choice.pack) || !TOP_UP_LEVELS.some((l) => l === choice.below)) return { error: "bad choice" };
  const row = await one<Row>("SELECT * FROM auto_topups WHERE user_id = ?", [user.id]);
  const card = Boolean(row?.payment_method);
  await run(
    `INSERT INTO auto_topups (user_id, enabled, pack, below, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, pack = excluded.pack, below = excluded.below,
       failed = CASE WHEN excluded.enabled = 1 THEN '' ELSE failed END, updated_at = excluded.updated_at`,
    [user.id, choice.enabled && card ? 1 : 0, choice.pack, choice.below, now()],
  );
  if (!choice.enabled || card) return {};
  if (!paymentsEnabled()) return { error: "payments off" };
  // A card is saved on a Stripe customer of the person's own: an earlier one, else a new one.
  const known = await one<{ customer: string }>(
    `SELECT customer FROM (SELECT customer, updated_at AS t FROM auto_topups WHERE user_id = ? AND customer IS NOT NULL
       UNION ALL SELECT customer, created_at AS t FROM subscriptions WHERE user_id = ? AND customer IS NOT NULL) ORDER BY t DESC LIMIT 1`,
    [user.id, user.id],
  );
  const customer =
    known?.customer ??
    (await stripe<{ id: string }>("POST", "/customers", new URLSearchParams({ email: user.email, "metadata[user]": user.id }))).id;
  await run("UPDATE auto_topups SET customer = ? WHERE user_id = ?", [customer, user.id]);
  const form = new URLSearchParams({
    mode: "setup",
    currency: currency(),
    customer,
    "payment_method_types[0]": "card",
    // The billing address works out sales tax on top-ups (see topUpNow).
    billing_address_collection: "required",
    client_reference_id: user.id,
    "metadata[user]": user.id,
    "metadata[auto_topup]": "1",
    "setup_intent_data[metadata][user]": user.id,
    success_url: `${origin}/?purchase=auto-topup`,
    cancel_url: `${origin}/?purchase=cancelled`,
  });
  const session = await stripe<{ url?: string }>("POST", "/checkout/sessions", form);
  if (!session.url) throw new Error("Stripe didn't return a checkout link");
  return { url: session.url };
}

/** The webhook's completed setup checkout: keeps the card and turns auto top-up on. */
export async function saveCard(sessionId: string): Promise<boolean> {
  const session = await stripe<{
    customer?: string | null;
    metadata?: { user?: string; auto_topup?: string } | null;
    setup_intent?: { payment_method?: string | null; status?: string } | null;
  }>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=setup_intent`);
  const user = session.metadata?.user;
  const pm = session.setup_intent?.payment_method;
  if (!user || session.metadata?.auto_topup !== "1" || !pm || session.setup_intent?.status !== "succeeded") return false;
  const r = await run(
    "UPDATE auto_topups SET payment_method = ?, customer = COALESCE(?, customer), enabled = 1, failed = '', updated_at = ? WHERE user_id = ?",
    [pm, session.customer ?? null, now(), user],
  );
  return r.rowsAffected === 1;
}

type PaymentIntent = { id: string; status: string; last_payment_error?: { message?: string } | null };

/** Sales tax for a top-up from the card's billing address, or none with tax off. */
async function taxFor(row: Row, priceCents: number): Promise<{ total: number; calculation: string | null }> {
  if (!taxOn()) return { total: priceCents, calculation: null };
  const pm = await stripe<{ billing_details?: { address?: Record<string, string | null> | null } | null }>(
    "GET",
    `/payment_methods/${encodeURIComponent(row.payment_method!)}`,
  );
  const form = new URLSearchParams({
    currency: currency(),
    "line_items[0][amount]": String(priceCents),
    "line_items[0][reference]": row.pack,
    "line_items[0][tax_behavior]": "exclusive",
    "customer_details[address_source]": "billing",
  });
  for (const [k, v] of Object.entries(pm.billing_details?.address ?? {})) if (v) form.set(`customer_details[address][${k}]`, v);
  const calc = await stripe<{ id: string; amount_total: number }>("POST", "/tax/calculations", form);
  return { total: calc.amount_total, calculation: calc.id };
}

/**
 * Turns auto top-up off with the reason shown in Credits. While it was on, low-credit emails waited
 * for it (see low-balance.ts), so the balance is looked at again now, whoever tried (a spend, chat, /api/me).
 */
async function stop(userId: string, reason: string): Promise<void> {
  await run("UPDATE auto_topups SET enabled = 0, failed = ?, updated_at = ? WHERE user_id = ?", [reason.slice(0, 200), now(), userId]);
  await checkLowBalance(userId).catch((err) => console.error("[flash] low-credit check failed", err));
}

/**
 * Buys the person's pack when their own balance is below their level and the limits allow it.
 * Safe to call often and at the same time: a claim on last_at lets one call through at a time.
 * Returns whether a pack was bought.
 */
export async function maybeAutoTopUp(userId: string): Promise<boolean> {
  if (!paymentsEnabled()) return false;
  const row = await one<Row>("SELECT * FROM auto_topups WHERE user_id = ? AND enabled = 1 AND payment_method IS NOT NULL", [userId]);
  const pack = CREDIT_PACKS.find((p) => p.id === row?.pack);
  // A visitor's question still being answered doesn't count (see topUpBalance).
  if (!row || !pack || (await topUpBalance(userId)) >= Number(row.below)) return false;
  if ((await topUpsThisMonth(userId)) >= MAX_PER_MONTH || (await disputed(userId))) return false;
  const at = now();
  const claim = await run("UPDATE auto_topups SET last_at = ? WHERE user_id = ? AND enabled = 1 AND last_at < ?", [at, userId, at - GAP_MINUTES * 60_000]);
  if (claim.rowsAffected !== 1) return false;
  let intent: PaymentIntent;
  let calculation: string | null;
  try {
    const tax = await taxFor(row, pack.priceCents);
    calculation = tax.calculation;
    intent = await stripe<PaymentIntent>(
      "POST",
      "/payment_intents",
      new URLSearchParams({
        amount: String(tax.total),
        currency: currency(),
        customer: row.customer ?? "",
        payment_method: row.payment_method!,
        off_session: "true",
        confirm: "true",
        description: `Flash AI ${pack.name}: ${pack.credits.toLocaleString("en-US")} credits (auto top-up)`,
        "metadata[user]": userId,
        "metadata[pack]": pack.id,
        "metadata[auto_topup]": "1",
      }),
    );
  } catch (err) {
    // Stripe answers a declined card with an error: say why, and stop until the person looks.
    await stop(userId, err instanceof Error ? err.message : "The payment didn't go through.");
    return false;
  }
  if (intent.status !== "succeeded") {
    await stop(userId, intent.last_payment_error?.message ?? "Your bank asked to confirm the payment.");
    return false;
  }
  // The "stripe:" ref counts it as a real sale; refunds and disputes find it by its payment.
  await addPurchase(userId, pack.id, `stripe:auto:${intent.id}`, intent.id);
  if (calculation) {
    await stripe("POST", "/tax/transactions/create_from_calculation", new URLSearchParams({ calculation, reference: intent.id })).catch((err) =>
      console.error("[flash] tax transaction failed", err),
    );
  }
  return true;
}
