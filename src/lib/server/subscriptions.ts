import { CARRY_CAP_FROM, CARRY_MONTHS, EXTRA_SEAT, LEGACY_PLAN_CREDITS, PLANS, carryOverTrim, planCredits, planPrice, seatsPrice, type Interval, type Plan } from "../credits.ts";
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
  created_at: number;
  extra_seats: number;
  // The monthly credits it was sold with; null for subscriptions from before 2026-10-20.
  plan_credits: number | null;
};

export const planById = (id: string | undefined): Plan | undefined => PLANS.find((p) => p.id === id);
export const isInterval = (v: unknown): v is Interval => v === "month" || v === "year";

/**
 * The monthly credits a subscription gets: what it was sold with, so a later price change never
 * changes an existing subscriber's credits. Those from before 2026-10-20 still pay the old price
 * through Stripe, so they get the old credits (LEGACY_PLAN_CREDITS).
 */
export function subscriptionCredits(sub: Subscription, plan: Plan): number {
  if (sub.plan_credits !== null && sub.plan_credits !== undefined) return Number(sub.plan_credits);
  const seats = plan.seats ? Number(sub.extra_seats ?? 0) : 0;
  return (LEGACY_PLAN_CREDITS[plan.id] ?? plan.credits) + seats * EXTRA_SEAT.credits;
}

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
  const ref = `plan:${sub.id}:${n}`;
  const r = await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [sub.user_id, subscriptionCredits(sub, plan), `${plan.name} plan monthly credits`, ref, at],
  );
  if (r.rowsAffected !== 1) return false;
  if (n > 0 && Number(sub.created_at) >= CARRY_CAP_FROM) await capCarryOver(sub, plan, ref, n, at);
  return true;
}

/**
 * Takes off plan credits left from earlier months above CARRY_MONTHS months' worth (see
 * carryOverTrim), once per month. Everything but plan grants that was ever added counts as kept.
 */
async function capCarryOver(sub: Subscription, plan: Plan, grantRef: string, n: number, at: number): Promise<void> {
  const row = await one<{ before: number; kept: number }>(
    `SELECT COALESCE(SUM(CASE WHEN ref IS NULL OR ref <> ? THEN amount ELSE 0 END), 0) AS before,
            COALESCE(SUM(CASE WHEN amount > 0 AND (ref IS NULL OR ref NOT LIKE 'plan:%') THEN amount ELSE 0 END), 0) AS kept
     FROM credit_ledger WHERE user_id = ?`,
    [grantRef, sub.user_id],
  );
  const trim = carryOverTrim(Number(row?.before ?? 0), Number(row?.kept ?? 0), subscriptionCredits(sub, plan));
  if (trim <= 0) return;
  await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [sub.user_id, -trim, `Plan credits over ${CARRY_MONTHS} months' worth`, `carry:${sub.id}:${n}`, at],
  );
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
  // Seats bought on top of a team plan's own (see EXTRA_SEAT).
  extraSeats?: number;
}): Promise<boolean> {
  const plan = planById(p.planId);
  if (!plan) return false;
  const seats = plan.seats ? Math.max(0, p.extraSeats ?? 0) : 0;
  const t = now();
  await run(
    `INSERT INTO subscriptions (id, user_id, plan, interval, status, customer, amount_cents, anchor, paid_until, test, created_at, updated_at, extra_seats, plan_credits)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET paid_until = MAX(paid_until, excluded.paid_until), status = 'active',
       customer = COALESCE(excluded.customer, customer), updated_at = excluded.updated_at`,
    [p.subscriptionId, p.userId, plan.id, p.interval, p.customer, planPrice(plan, p.interval) + seatsPrice(seats, p.interval), p.periodStart,
      p.periodEnd, p.test ? 1 : 0, t, t, seats, planCredits(plan, seats)],
  );
  const sub = await one<Subscription>("SELECT * FROM subscriptions WHERE id = ?", [p.subscriptionId]);
  await run(
    `INSERT OR IGNORE INTO purchases (user_id, pack, credits, amount_cents, test, ref, payment_intent, subscription, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.userId, `plan:${plan.id}:${p.interval}`, sub ? subscriptionCredits(sub, plan) : planCredits(plan, seats), p.amountCents,
      p.test ? 1 : 0, p.ref, p.paymentIntent ?? null, p.subscriptionId, t],
  );
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
    credits: subscriptionCredits(sub, plan),
    extraSeats: Number(sub.extra_seats ?? 0),
    nextCredits: Math.min(addMonths(sub.anchor, n + 1), sub.paid_until),
    renews: !sub.cancel_at_period_end,
    // A prepaid pass bought with mobile money (see pawapay.ts): no billing portal, renewed by buying again.
    prepaid: sub.id.startsWith("pawapay"),
    paidUntil: sub.paid_until,
    test: Boolean(sub.test),
  };
}

export type PlanSummary = Awaited<ReturnType<typeof planSummary>>;
