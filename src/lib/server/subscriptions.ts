import { PLANS, planPrice, type Interval, type Plan } from "../credits.ts";
import { all, one, run, now } from "./db.ts";

export type Subscription = {
  id: string;
  user_id: string;
  plan: string;
  interval: Interval;
  status: string;
  cancel_at_period_end: number;
  customer: string | null;
  amount_cents: number;
  anchor: number;
  paid_until: number;
  test: number;
};

export const planById = (id: string | undefined): Plan | undefined => PLANS.find((p) => p.id === id);
export const isInterval = (v: unknown): v is Interval => v === "month" || v === "year";

/** The date n whole months after start, keeping the day of the month where it exists. */
export function addMonths(start: number, n: number): number {
  const d = new Date(start);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

/** How many whole months have passed since start. */
export function monthsSince(start: number, at: number): number {
  let n = Math.max(0, (new Date(at).getUTCFullYear() - new Date(start).getUTCFullYear()) * 12 +
    new Date(at).getUTCMonth() - new Date(start).getUTCMonth());
  while (n > 0 && addMonths(start, n) > at) n--;
  return n;
}

/** The user's paid-up subscription, if any. */
export async function activeSubscription(userId: string): Promise<Subscription | null> {
  return one<Subscription>(
    "SELECT * FROM subscriptions WHERE user_id = ? AND paid_until > ? ORDER BY paid_until DESC LIMIT 1",
    [userId, now()],
  );
}

/**
 * Gives this month's plan credits once. A month counts only if it started before the date the
 * subscriber has paid up to, so every grant is backed by a payment and no plan runs at a loss.
 */
export async function grantPlanCredits(sub: Subscription, at = now()): Promise<boolean> {
  const plan = planById(sub.plan);
  if (!plan) return false;
  const n = monthsSince(sub.anchor, at);
  if (addMonths(sub.anchor, n) >= sub.paid_until) return false;
  const r = await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [sub.user_id, plan.credits, `${plan.name} plan monthly credits`, `plan:${sub.id}:${n}`, at],
  );
  return r.rowsAffected === 1;
}

/** Records a paid subscription period (a Stripe invoice, or a demo purchase) and grants credits. */
export async function recordPayment(p: {
  subscriptionId: string;
  userId: string;
  planId: string;
  interval: Interval;
  customer: string | null;
  amountCents: number;
  periodStart: number;
  periodEnd: number;
  ref: string;
  test: boolean;
  paymentIntent?: string | null;
}): Promise<boolean> {
  const plan = planById(p.planId);
  if (!plan) return false;
  const t = now();
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, customer, amount_cents, anchor, paid_until, test, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET paid_until = MAX(paid_until, excluded.paid_until), status = 'active',
       customer = COALESCE(excluded.customer, customer), updated_at = excluded.updated_at`,
    [p.subscriptionId, p.userId, plan.id, p.interval, p.customer, planPrice(plan, p.interval), p.periodStart,
      p.periodEnd, p.test ? 1 : 0, t, t],
  );
  await run(
    `INSERT OR IGNORE INTO purchases (user_id, pack, credits, amount_cents, test, ref, payment_intent, subscription, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.userId, `plan:${plan.id}:${p.interval}`, plan.credits, p.amountCents, p.test ? 1 : 0, p.ref,
      p.paymentIntent ?? null, p.subscriptionId, t],
  );
  const sub = await one<Subscription>("SELECT * FROM subscriptions WHERE id = ?", [p.subscriptionId]);
  if (sub) await grantPlanCredits(sub);
  return true;
}

/** The user's other subscriptions, which end when they switch plans. Returns their ids. */
export async function otherSubscriptions(userId: string, keepId: string): Promise<Subscription[]> {
  return all<Subscription>("SELECT * FROM subscriptions WHERE user_id = ? AND id != ? AND paid_until > ?", [
    userId,
    keepId,
    now(),
  ]);
}

/** Ends a subscription now: no more monthly credits (credits already given stay). */
export async function endSubscription(id: string): Promise<void> {
  const t = now();
  await run(
    "UPDATE subscriptions SET status = 'canceled', paid_until = MIN(paid_until, ?), updated_at = ? WHERE id = ?",
    [t, t, id],
  );
}

export async function setCancelAtPeriodEnd(id: string, cancel: boolean, status?: string): Promise<void> {
  await run(
    "UPDATE subscriptions SET cancel_at_period_end = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?",
    [cancel ? 1 : 0, status ?? null, now(), id],
  );
}

/** What the signed-in user sees about their plan. */
export async function planSummary(userId: string) {
  const sub = await activeSubscription(userId);
  const plan = sub && planById(sub.plan);
  if (!sub || !plan) return null;
  const n = monthsSince(sub.anchor, now());
  return {
    id: plan.id,
    name: plan.name,
    interval: sub.interval,
    credits: plan.credits,
    nextCredits: Math.min(addMonths(sub.anchor, n + 1), sub.paid_until),
    renews: !sub.cancel_at_period_end,
    paidUntil: sub.paid_until,
    test: Boolean(sub.test),
  };
}

export type PlanSummary = Awaited<ReturnType<typeof planSummary>>;
