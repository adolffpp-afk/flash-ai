import { all, now, one, run } from "./db.ts";
import { MARKUP, paymentFeeCents } from "../credits.ts";
import { saleFee } from "../shop.ts";

/**
 * The owner dashboard's Net profit: what Flash took in over a time range, minus everything that
 * came off it. Amounts are in US cents, the currency Flash charges in (FLASH_CURRENCY).
 */

// Stripe Canada charges CA$15 for each dispute, which is about US$11.
export const DISPUTE_FEE_CENTS = 1100;
export const MAX_FIXED_COSTS = 50;

export type FixedCost = { id: number; name: string; amountCents: number; per: "month" | "year" };

/** What a bill paid every month or year comes to over a number of days. */
export const fixedCostOver = (c: Pick<FixedCost, "amountCents" | "per">, days: number) =>
  Math.round(((c.per === "year" ? c.amountCents : c.amountCents * 12) / 365) * days);

export async function fixedCosts(): Promise<FixedCost[]> {
  const rows = await all<{ id: number; name: string; amount_cents: number; per: string }>(
    "SELECT id, name, amount_cents, per FROM admin_costs ORDER BY id",
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, amountCents: Number(r.amount_cents), per: r.per === "year" ? "year" : "month" }));
}

/** Adds a bill the owner pays; false when the list is full. */
export async function addFixedCost(c: Omit<FixedCost, "id">): Promise<boolean> {
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM admin_costs");
  if (Number(count?.n ?? 0) >= MAX_FIXED_COSTS) return false;
  await run("INSERT INTO admin_costs (name, amount_cents, per, created_at) VALUES (?, ?, ?, ?)", [c.name, c.amountCents, c.per, now()]);
  return true;
}

// Up to a million US dollars a month or year, which no real bill of Flash's comes near.
const MAX_AMOUNT_CENTS = 100_000_000;

/** A bill the owner typed in ({ name, amount in US dollars, per }), or why it can't be added. */
export function readFixedCost(body: unknown): Omit<FixedCost, "id"> | { error: string } {
  const b = (body ?? {}) as { name?: unknown; amount?: unknown; per?: unknown };
  const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  const amount = typeof b.amount === "number" || typeof b.amount === "string" ? Number(b.amount) : NaN;
  const amountCents = Math.round(amount * 100);
  if (!name || name.length > 60) return { error: "Give the bill a name of up to 60 characters." };
  if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    return { error: "Type the amount in US dollars, like 20 or 4.99." };
  }
  if (b.per !== "month" && b.per !== "year") return { error: "Choose per month or per year." };
  return { name, amountCents, per: b.per };
}

export async function removeFixedCost(id: number): Promise<void> {
  await run("DELETE FROM admin_costs WHERE id = ?", [id]);
}

export type ProfitReport = {
  days: number;
  plansCents: number;
  packsCents: number;
  planPayments: number;
  packPayments: number;
  // Flash's share of sales on published sites, in US dollars; sales in other currencies are listed apart.
  siteFeesCents: number;
  siteSales: number;
  otherSiteFees: { currency: string; cents: number; sales: number }[];
  refundsCents: number;
  refunds: number;
  disputesCents: number;
  disputes: number;
  stripeFeesCents: number;
  disputeFeesCents: number;
  aiCostCents: number;
  fixed: (FixedCost & { rangeCents: number })[];
  fixedCents: number;
  grossCents: number;
  netCents: number;
  // The most the credits people hold but haven't used yet could still cost in AI.
  unspentCostCents: number;
};

/** Net profit since a time: sales and site fees, minus refunds, disputes, Stripe fees, AI and fixed bills. */
export async function profitReport(since: number, days: number, feeBps: number): Promise<ProfitReport> {
  const n = (v: unknown) => Number(v ?? 0);
  const sales = await all<{ pack: string; amount_cents: number }>(
    "SELECT pack, amount_cents FROM purchases WHERE test = 0 AND created_at >= ?",
    [since],
  );
  const isPlan = (pack: string) => pack.startsWith("plan:");
  const plansCents = sales.filter((s) => isPlan(s.pack)).reduce((sum, s) => sum + n(s.amount_cents), 0);
  const packsCents = sales.filter((s) => !isPlan(s.pack)).reduce((sum, s) => sum + n(s.amount_cents), 0);
  // Stripe keeps its fee when a payment is refunded, so every payment's fee counts.
  const stripeFeesCents = Math.round(sales.reduce((sum, s) => sum + paymentFeeCents(n(s.amount_cents), isPlan(s.pack)), 0));

  const orders = await all<{ amount: number; currency: string }>("SELECT amount, currency FROM site_orders WHERE created_at >= ?", [since]);
  const fees = new Map<string, { cents: number; sales: number }>();
  for (const o of orders) {
    const currency = String(o.currency || "usd").toLowerCase();
    const seen = fees.get(currency) ?? { cents: 0, sales: 0 };
    fees.set(currency, { cents: seen.cents + saleFee(n(o.amount), feeBps), sales: seen.sales + 1 });
  }
  const usd = fees.get("usd") ?? { cents: 0, sales: 0 };
  const otherSiteFees = [...fees.entries()]
    .filter(([currency]) => currency !== "usd")
    .map(([currency, f]) => ({ currency: currency.toUpperCase(), ...f }));

  const back = await all<{ kind: string; cents: number; charges: number }>(
    `SELECT kind, COALESCE(SUM(amount_cents), 0) AS cents, COUNT(DISTINCT charge) AS charges
     FROM payment_reversals WHERE test = 0 AND created_at >= ? GROUP BY kind`,
    [since],
  );
  const refund = back.find((r) => r.kind === "refund");
  const dispute = back.find((r) => r.kind === "dispute");

  const ai = await one<{ cost: number }>("SELECT COALESCE(SUM(cost_cents), 0) AS cost FROM usage WHERE created_at >= ?", [since]);
  const fixed = (await fixedCosts()).map((c) => ({ ...c, rangeCents: fixedCostOver(c, days) }));
  const outstanding = await one<{ credits: number }>("SELECT COALESCE(SUM(amount), 0) AS credits FROM credit_ledger");

  const grossCents = plansCents + packsCents + usd.cents - n(refund?.cents) - n(dispute?.cents);
  const disputeFeesCents = n(dispute?.charges) * DISPUTE_FEE_CENTS;
  const fixedCents = fixed.reduce((sum, c) => sum + c.rangeCents, 0);
  const aiCostCents = n(ai?.cost);
  return {
    days,
    plansCents,
    packsCents,
    planPayments: sales.filter((s) => isPlan(s.pack)).length,
    packPayments: sales.filter((s) => !isPlan(s.pack)).length,
    siteFeesCents: usd.cents,
    siteSales: usd.sales,
    otherSiteFees,
    refundsCents: n(refund?.cents),
    refunds: n(refund?.charges),
    disputesCents: n(dispute?.cents),
    disputes: n(dispute?.charges),
    stripeFeesCents,
    disputeFeesCents,
    aiCostCents,
    fixed,
    fixedCents,
    grossCents,
    netCents: Math.round(grossCents - stripeFeesCents - disputeFeesCents - aiCostCents - fixedCents),
    unspentCostCents: Math.max(0, Math.round(n(outstanding?.credits) / MARKUP)),
  };
}
