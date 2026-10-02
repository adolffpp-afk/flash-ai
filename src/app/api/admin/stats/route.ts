import { getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { all, one } from "@/lib/server/db.ts";

export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;

/** Owner dashboard numbers: users, revenue, credits and what AI providers cost, for a time range. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });

  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 30));
  const since = Date.now() - days * DAY;
  const n = (v: unknown) => Number(v ?? 0);

  const users = await one<{ total: number; recent: number }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent FROM users",
    [since],
  );
  const usage = await one<{ requests: number; failed: number; credits: number; cost: number; active: number }>(
    `SELECT COUNT(*) AS requests, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
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
    `SELECT engine, COUNT(*) AS requests, COALESCE(SUM(credits), 0) AS credits, COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? GROUP BY engine ORDER BY cost DESC`,
    [since],
  );
  const byProvider = await all<{ provider: string; requests: number; cost: number }>(
    `SELECT provider, COUNT(*) AS requests, COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? AND provider != '' GROUP BY provider ORDER BY cost DESC`,
    [since],
  );
  const byModel = await all<{ model: string; provider: string; requests: number; cost: number }>(
    `SELECT model, provider, COUNT(*) AS requests, COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? AND model != '' GROUP BY model, provider ORDER BY cost DESC LIMIT 15`,
    [since],
  );
  const daily = await all<{ day: number; requests: number; cost: number }>(
    `SELECT CAST(created_at / ? AS INTEGER) AS day, COUNT(*) AS requests, COALESCE(SUM(cost_cents), 0) AS cost
     FROM usage WHERE created_at >= ? GROUP BY day ORDER BY day`,
    [DAY, since],
  );
  const topUsers = await all<{ email: string; requests: number; credits: number; cost: number }>(
    `SELECT u.email, COUNT(*) AS requests, COALESCE(SUM(g.credits), 0) AS credits, COALESCE(SUM(g.cost_cents), 0) AS cost
     FROM usage g JOIN users u ON u.id = g.user_id
     WHERE g.created_at >= ? GROUP BY g.user_id ORDER BY cost DESC LIMIT 10`,
    [since],
  );
  const signups = await all<{ email: string; name: string; created_at: number }>(
    "SELECT email, name, created_at FROM users ORDER BY created_at DESC LIMIT 10",
  );

  // One row per day in the range, so quiet days show as zero.
  const firstDay = Math.floor(since / DAY) + 1;
  const lastDay = Math.floor(Date.now() / DAY);
  const series = [];
  for (let d = firstDay; d <= lastDay; d++) {
    const row = daily.find((r) => n(r.day) === d);
    series.push({ day: d * DAY, requests: n(row?.requests), costCents: n(row?.cost) });
  }

  return Response.json({
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
    byProvider: byProvider.map((r) => ({ provider: r.provider, requests: n(r.requests), costCents: n(r.cost) })),
    byModel: byModel.map((r) => ({ model: r.model, provider: r.provider, requests: n(r.requests), costCents: n(r.cost) })),
    series,
    topUsers: topUsers.map((r) => ({ email: r.email, requests: n(r.requests), credits: n(r.credits), costCents: n(r.cost) })),
    signups,
  });
}
