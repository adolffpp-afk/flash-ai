import { all, one } from "./db.ts";
import { CREDIT_PACKS, MARKUP, PLANS, paymentFeeCents, planPrice, worstCaseProfitCents } from "../credits.ts";
import { PROVIDER_LIST, providerName, providerSetUp } from "../providers.ts";
import { profitReport } from "./profit.ts";
import { feeBps } from "./shop.ts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Owner dashboard numbers: users, revenue, credits, what AI providers cost and net profit, over
 * the last days. A request's usage rows are its main row (part 0) plus one per helper provider
 * (part 1), so request counts read only main rows and costs read them all.
 */
export async function adminStats(days: number) {
  const since = Date.now() - days * DAY;
  const n = (v: unknown) => Number(v ?? 0);

  const users = await one<{ total: number; recent: number }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM users",
    [since],
  );
  const usage = await one<{ requests: number; failed: number; credits: number; cost: number; active: number }>(
    `SELECT SUM(CASE WHEN part = 0 THEN 1 ELSE 0 END) AS requests, SUM(CASE WHEN part = 0 AND ok = 0 THEN 1 ELSE 0 END) AS failed,
            COALESCE(SUM(credits), 0) AS credits, COALESCE(SUM(cost_cents), 0) AS cost,
            COUNT(DISTINCT user_id) AS active
     FROM usage WHERE created_at >= ?`,
    [since],
  );
  const revenue = await one<{ paid: number; test: number; orders: number }>(
    `SELECT COALESCE(SUM(CASE WHEN test = 0 THEN amount_cents END), 0) AS paid,
            COALESCE(SUM(CASE WHEN test = 1 THEN amount_cents END), 0) AS test,
            SUM(CASE WHEN test = 0 THEN 1 ELSE 0 END) AS orders
     FROM purchases WHERE created_at >= ?`,
    [since],
  );
  const outstanding = await one<{ credits: number }>("SELECT COALESCE(SUM(amount), 0) AS credits FROM credit_ledger");

  const byEngine = await all<{ engine: string; requests: number; credits: number; cost: number }>(
    `SELECT engine, SUM(CASE WHEN part = 0 THEN 1 ELSE 0 END) AS requests, COALESCE(SUM(credits), 0) AS credits,
            COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? GROUP BY engine ORDER BY cost DESC`,
    [since],
  );
  // Uses counts each request a provider worked on, as the main provider or as a helper.
  const providerUse = await all<{ provider: string; requests: number; cost: number }>(
    `SELECT provider, COUNT(*) AS requests, COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? AND provider != '' GROUP BY provider`,
    [since],
  );
  // Every provider Flash can call, used or not, then any other provider the usage log names.
  const byProvider = [
    ...PROVIDER_LIST.map((p) => ({ id: p.id, does: p.does, free: p.free, setUp: providerSetUp(p, process.env) })),
    ...providerUse
      .filter((r) => !PROVIDER_LIST.some((p) => p.id === r.provider))
      .map((r) => ({ id: r.provider, does: "", free: false, setUp: true })),
  ]
    .map((p) => {
      const use = providerUse.find((r) => r.provider === p.id);
      return { ...p, provider: providerName(p.id), requests: n(use?.requests), costCents: n(use?.cost) };
    })
    .sort((a, b) => b.costCents - a.costCents || b.requests - a.requests || Number(a.free) - Number(b.free));
  const byModel = await all<{ model: string; provider: string; requests: number; cost: number }>(
    `SELECT model, provider, COUNT(*) AS requests, COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? AND model != '' GROUP BY model, provider ORDER BY cost DESC LIMIT 15`,
    [since],
  );
  const daily = await all<{ day: number; requests: number; cost: number }>(
    `SELECT CAST(created_at / ? AS INTEGER) AS day, SUM(CASE WHEN part = 0 THEN 1 ELSE 0 END) AS requests, COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? GROUP BY day ORDER BY day`,
    [DAY, since],
  );
  const topUsers = await all<{ email: string; requests: number; credits: number; cost: number }>(
    `SELECT u.email, SUM(CASE WHEN g.part = 0 THEN 1 ELSE 0 END) AS requests, COALESCE(SUM(g.credits), 0) AS credits, COALESCE(SUM(g.cost_cents), 0) AS cost
     FROM usage g JOIN users u ON u.id = g.user_id
     WHERE g.created_at >= ? GROUP BY g.user_id ORDER BY cost DESC LIMIT 10`,
    [since],
  );
  const signups = await all<{ email: string; name: string; created_at: number }>(
    "SELECT email, name, created_at FROM users ORDER BY created_at DESC LIMIT 10",
  );

  // Paid-up subscriptions right now, by plan and billing period. MRR counts yearly plans per month.
  const subs = await all<{ plan: string; interval: string; test: number; count: number; amount: number }>(
    `SELECT plan, interval, test, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount
     FROM subscriptions WHERE paid_until > ? GROUP BY plan, interval, test`,
    [Date.now()],
  );
  const monthly = (r: { interval: string; amount: number }) => (r.interval === "year" ? n(r.amount) / 12 : n(r.amount));
  const paidSubs = subs.filter((r) => !n(r.test));
  // Worst case for each plan and pack: the buyer uses every credit.
  const planEconomics = [
    ...PLANS.flatMap((p) =>
      (["month", "year"] as const).map((interval) => {
        const price = planPrice(p, interval);
        const months = interval === "year" ? 12 : 1;
        return {
          name: `${p.name} (${interval === "year" ? "yearly" : "monthly"})`,
          priceCents: price / months,
          credits: p.credits,
          costCents: p.credits / MARKUP,
          feeCents: paymentFeeCents(price, true) / months,
          profitCents: worstCaseProfitCents(price, p.credits, true, months),
          subscribers: n(paidSubs.find((r) => r.plan === p.id && r.interval === interval)?.count),
        };
      }),
    ),
    ...CREDIT_PACKS.map((p) => ({
      name: `${p.name} top-up`,
      priceCents: p.priceCents,
      credits: p.credits,
      costCents: p.credits / MARKUP,
      feeCents: paymentFeeCents(p.priceCents, false),
      profitCents: worstCaseProfitCents(p.priceCents, p.credits, false),
      subscribers: null,
    })),
  ];

  // One row per day in the range, so quiet days show as zero.
  const firstDay = Math.floor(since / DAY) + 1;
  const lastDay = Math.floor(Date.now() / DAY);
  const series = [];
  for (let d = firstDay; d <= lastDay; d++) {
    const row = daily.find((r) => n(r.day) === d);
    series.push({ day: d * DAY, requests: n(row?.requests), costCents: n(row?.cost) });
  }

  return {
    days,
    users: { total: n(users?.total), new: n(users?.recent), active: n(usage?.active) },
    requests: { total: n(usage?.requests), failed: n(usage?.failed) },
    creditsUsed: n(usage?.credits),
    creditsOutstanding: n(outstanding?.credits),
    revenueCents: n(revenue?.paid),
    testRevenueCents: n(revenue?.test),
    orders: n(revenue?.orders),
    costCents: n(usage?.cost),
    byEngine: byEngine.map((r) => ({ engine: r.engine, requests: n(r.requests), credits: n(r.credits), costCents: n(r.cost) })),
    byProvider,
    byModel: byModel.map((r) => ({ model: r.model, provider: r.provider, requests: n(r.requests), costCents: n(r.cost) })),
    series,
    topUsers: topUsers.map((r) => ({ email: r.email, requests: n(r.requests), credits: n(r.credits), costCents: n(r.cost) })),
    signups,
    subscribers: paidSubs.reduce((sum, r) => sum + n(r.count), 0),
    testSubscribers: subs.filter((r) => n(r.test)).reduce((sum, r) => sum + n(r.count), 0),
    mrrCents: paidSubs.reduce((sum, r) => sum + monthly(r), 0),
    planEconomics,
    profit: await profitReport(since, days, feeBps()),
  };
}
