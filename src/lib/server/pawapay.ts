/*
 * Mobile money through pawaPay (see ../mobile-money.ts for countries, prices and passes).
 *
 * A purchase is an order kept here with the exact local amount asked for. The buyer pays on
 * pawaPay's Payment Page, which sends them back to Flash, and pawaPay also calls
 * /api/pawapay/callback. Neither is trusted on its own: both only make Flash ask pawaPay's API for
 * the deposit's status, and credits come only for a COMPLETED deposit of the order's full amount
 * in its currency. Claiming the order first means a deposit is only ever paid out once.
 *
 * Keys: PAWAPAY_LIVE_KEY for real payments; without it, PAWAPAY_SANDBOX_KEY uses pawaPay's sandbox,
 * where nothing is really paid, so only admins can buy there and what they buy is marked test.
 */
import { addMonths, activeSubscription, endSubscription, monthsSince, otherSubscriptions, recordPayment, setCancelAtPeriodEnd } from "./subscriptions.ts";
import { addPurchase } from "./credits.ts";
import { cancelStripeSubscription } from "./stripe.ts";
import { all, one, run, now } from "./db.ts";
import { usdRate } from "./fx.ts";
import { randomUUID } from "node:crypto";
import { mobileMoneyAmount, mobileMoneyCountry, mobileMoneyProduct, MOBILE_MONEY_PRODUCTS, type MobileMoneyCountry } from "../mobile-money.ts";

type Mode = "live" | "sandbox";
const API: Record<Mode, string> = { live: "https://api.pawapay.io", sandbox: "https://api.sandbox.pawapay.io" };
const KEY: Record<Mode, string> = { live: "PAWAPAY_LIVE_KEY", sandbox: "PAWAPAY_SANDBOX_KEY" };

/** Which pawaPay Flash takes payments with, or null when neither key is set. */
export function pawapayMode(): Mode | null {
  if (process.env.PAWAPAY_LIVE_KEY?.trim()) return "live";
  if (process.env.PAWAPAY_SANDBOX_KEY?.trim()) return "sandbox";
  return null;
}

/** Whether this person can pay with mobile money: anyone once live, only admins in the sandbox. */
export const mobileMoneyFor = (admin: boolean): Mode | null => {
  const mode = pawapayMode();
  return mode === "live" || (mode === "sandbox" && admin) ? mode : null;
};

async function pawapay<T>(mode: Mode, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${API[mode]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env[KEY[mode]]?.trim()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

/** Every product's price in a country's money, by product id, or null without the day's rate. */
export async function mobileMoneyPrices(country: MobileMoneyCountry): Promise<Record<string, number> | null> {
  const rate = await usdRate(country.currency);
  if (!rate) return null;
  const prices: Record<string, number> = {};
  for (const p of MOBILE_MONEY_PRODUCTS) {
    const amount = mobileMoneyAmount(p.usdCents, rate, country);
    if (amount) prices[p.id] = amount;
  }
  return prices;
}

export type Order = {
  deposit_id: string;
  user_id: string;
  product: string;
  usd_cents: number;
  amount: string;
  currency: string;
  country: string;
  mode: Mode;
  status: "pending" | "completed" | "failed";
  created_at: number;
  settled_at: number;
};

export type StartResult = { url: string; depositId: string } | { error: "product" | "country" | "rate" | "rejected" | "failed"; message?: string };

/** Starts a purchase: keeps the order, then opens pawaPay's Payment Page for it. */
export async function startMobileMoney(
  user: { id: string },
  mode: Mode,
  productId: unknown,
  countryCode: unknown,
  origin: string,
): Promise<StartResult> {
  const product = mobileMoneyProduct(productId);
  if (!product) return { error: "product" };
  const country = mobileMoneyCountry(countryCode);
  if (!country) return { error: "country" };
  const rate = await usdRate(country.currency);
  const amount = rate ? mobileMoneyAmount(product.usdCents, rate, country) : null;
  if (!amount) return { error: "rate", message: `no exchange rate for ${country.currency}` };
  const depositId = randomUUID();
  await run(
    `INSERT INTO mobile_money_orders (deposit_id, user_id, product, usd_cents, amount, currency, country, mode, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [depositId, user.id, product.id, product.usdCents, String(amount), country.currency, country.code, mode, now()],
  );
  const reason = product.kind === "pack" ? `Flash ${product.name} credits` : `Flash ${product.name} ${product.interval === "year" ? "1 year" : "1 month"}`;
  try {
    const { status, json } = await pawapay<{ redirectUrl?: string; failureReason?: { failureCode?: string; failureMessage?: string } }>(
      mode,
      "POST",
      "/v2/paymentpage",
      {
        depositId,
        returnUrl: `${origin}/?mobile-money=1`,
        customerMessage: "Flash AI",
        amountDetails: { amount: String(amount), currency: country.currency },
        country: country.pawapay,
        reason,
        metadata: [{ product: product.id }],
      },
    );
    if (status === 200 && json.redirectUrl) return { url: json.redirectUrl, depositId };
    await run("UPDATE mobile_money_orders SET status = 'failed', settled_at = ? WHERE deposit_id = ?", [now(), depositId]);
    console.warn(`[flash] pawaPay refused deposit ${depositId}: ${status} ${json.failureReason?.failureCode ?? ""} ${json.failureReason?.failureMessage ?? ""}`);
    const detail = [status, json.failureReason?.failureCode, json.failureReason?.failureMessage].filter(Boolean).join(" ");
    return { error: "rejected", message: detail };
  } catch (err) {
    console.error("[flash] pawaPay payment page failed", err);
    return { error: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

type Deposit = { depositId?: string; status?: string; amount?: string; currency?: string };

/** What an order became: asks pawaPay and gives the credits once if it's paid. */
export async function settleMobileMoney(depositId: string): Promise<Order | null> {
  if (!/^[0-9a-f-]{36}$/i.test(depositId)) return null;
  const order = await one<Order>("SELECT * FROM mobile_money_orders WHERE deposit_id = ?", [depositId]);
  if (!order || order.status !== "pending") return order;
  const { status, json } = await pawapay<{ status?: string; data?: Deposit }>(order.mode, "GET", `/v2/deposits/${encodeURIComponent(depositId)}`);
  const deposit = status === 200 && json.status === "FOUND" ? json.data : undefined;
  if (!deposit || deposit.depositId !== order.deposit_id) return order;
  if (deposit.status === "FAILED") return finish(order, "failed");
  if (deposit.status !== "COMPLETED") return order;
  // The full amount, in the order's currency: anything else gives nothing.
  if (deposit.currency !== order.currency || !(Number(deposit.amount) >= Number(order.amount))) {
    console.warn(`[flash] pawaPay deposit ${depositId} paid ${deposit.amount} ${deposit.currency}, not ${order.amount} ${order.currency}: no credits given`);
    return finish(order, "failed");
  }
  // Only the request that claims the order gives its credits.
  const claimed = await run("UPDATE mobile_money_orders SET status = 'completed', settled_at = ? WHERE deposit_id = ? AND status = 'pending'", [now(), depositId]);
  if (claimed.rowsAffected !== 1) return one<Order>("SELECT * FROM mobile_money_orders WHERE deposit_id = ?", [depositId]);
  try {
    await give(order);
  } catch (err) {
    // Back to pending, so the next callback or check tries again.
    await run("UPDATE mobile_money_orders SET status = 'pending', settled_at = 0 WHERE deposit_id = ?", [depositId]);
    throw err;
  }
  return { ...order, status: "completed" };
}

async function finish(order: Order, status: "failed"): Promise<Order> {
  await run("UPDATE mobile_money_orders SET status = ?, settled_at = ? WHERE deposit_id = ? AND status = 'pending'", [status, now(), order.deposit_id]);
  return { ...order, status };
}

/** Gives what an order paid for: a pack's credits, or a pass. Referral bonuses don't apply. */
async function give(order: Order): Promise<void> {
  const product = mobileMoneyProduct(order.product);
  if (!product) throw new Error(`unknown mobile money product ${order.product}`);
  const test = order.mode !== "live";
  const ref = `${test ? "pawapay-sandbox" : "pawapay"}:${order.deposit_id}`;
  if (product.kind === "pack") {
    await addPurchase(order.user_id, product.packId, ref);
    return;
  }
  const months = product.interval === "year" ? 12 : 1;
  // The same pass bought again while it runs adds its months to the end; anything else starts today.
  const current = await activeSubscription(order.user_id);
  const renew =
    current && current.id.startsWith("pawapay") && current.plan === product.planId && current.interval === product.interval && !Number(current.extra_seats)
      ? current
      : null;
  const subscriptionId = renew?.id ?? `pawapay:${order.deposit_id}`;
  const start = renew ? Number(renew.anchor) : now();
  const end = renew ? addMonths(start, monthsSince(start, Number(renew.paid_until)) + months) : addMonths(start, months);
  await recordPayment({
    subscriptionId,
    userId: order.user_id,
    planId: product.planId,
    interval: product.interval,
    customer: null,
    amountCents: Number(order.usd_cents),
    periodStart: start,
    periodEnd: end,
    ref,
    test,
  });
  // A pass never renews by itself.
  await setCancelAtPeriodEnd(subscriptionId, true);
  // A new pass replaces the plan the person had, as switching plans does (no refund; credits stay).
  if (!renew) {
    for (const old of await otherSubscriptions(order.user_id, subscriptionId)) {
      if (!old.test && !old.id.startsWith("pawapay")) await cancelStripeSubscription(old.id).catch((err) => console.error("[flash] cancel failed", err));
      await endSubscription(old.id);
    }
  }
}

export type MobileMoneyRow = Order & { email: string | null };

/**
 * The owner dashboard's Mobile money tab: which key is in use, the last 30 days' orders by status
 * and what the paid ones were worth (US dollar prices, sandbox apart), passes running now, and the
 * latest orders (before: a created_at for the next page).
 */
export async function mobileMoneyReport(before = 0) {
  const since = now() - 30 * 24 * 3600 * 1000;
  const counts = await all<{ status: string; mode: string; n: number; cents: number }>(
    "SELECT status, mode, COUNT(*) AS n, COALESCE(SUM(usd_cents), 0) AS cents FROM mobile_money_orders WHERE created_at > ? GROUP BY status, mode",
    [since],
  );
  const passes = await one<{ n: number }>("SELECT COUNT(*) AS n FROM subscriptions WHERE id LIKE 'pawapay%' AND paid_until > ?", [now()]);
  const rows = await all<MobileMoneyRow>(
    `SELECT o.*, u.email FROM mobile_money_orders o LEFT JOIN users u ON u.id = o.user_id
     WHERE ? = 0 OR o.created_at < ? ORDER BY o.created_at DESC LIMIT 51`,
    [before, before],
  );
  return {
    mode: pawapayMode(),
    counts: counts.map((c) => ({ status: c.status, mode: c.mode, orders: Number(c.n), usdCents: Number(c.cents) })),
    activePasses: Number(passes?.n ?? 0),
    rows: rows.slice(0, 50),
    more: rows.length > 50,
  };
}
