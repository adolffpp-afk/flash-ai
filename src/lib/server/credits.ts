import { CREDIT_PACKS, FREE_MONTHLY_CREDITS } from "../credits.ts";
import { all, one, run, now } from "./db.ts";
import { activeSubscription, grantPlanCredits } from "./subscriptions.ts";
import { verificationRequired } from "./email.ts";
import { teamPool } from "./teams.ts";
import { releaseReferralBonuses } from "./referrals.ts";

export async function balance(userId: string): Promise<number> {
  const row = await one<{ total: number }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ?",
    [userId],
  );
  return Number(row?.total ?? 0);
}

/**
 * The ledgers a user spends from, in order: a team member's shared pool (the owner's balance,
 * while the owner's Business plan is paid up), then their own credits.
 */
export async function spendAccounts(userId: string): Promise<string[]> {
  const pool = await teamPool(userId);
  return pool ? [pool.user_id, userId] : [userId];
}

/**
 * What a user can spend: the most one request can hold (one ledger pays for each request) and
 * the total to show, the team pool included.
 */
export async function spendable(userId: string): Promise<{ largest: number; total: number; pool: number | null }> {
  const accounts = await spendAccounts(userId);
  const balances = await Promise.all(accounts.map(balance));
  return {
    largest: Math.max(...balances),
    total: balances.reduce((a, b) => a + b, 0),
    pool: accounts.length > 1 ? balances[0] : null,
  };
}

const monthKey = (t = new Date()) => `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Gives subscribers this month's plan credits, or tops the free allowance back up once per
 * calendar month for everyone else (never takes credits away). Then credits any referral
 * bonuses whose waiting time is over (after the top-up, so they never shrink it).
 */
export async function ensureMonthlyCredits(userId: string): Promise<void> {
  await monthlyCredits(userId);
  await releaseReferralBonuses(userId);
}

async function monthlyCredits(userId: string): Promise<void> {
  // A team member's shared pool gets its monthly credits too (each grant is backed by a payment).
  const pool = await teamPool(userId);
  if (pool) await grantPlanCredits(pool);
  const sub = await activeSubscription(userId);
  if (sub) {
    await grantPlanCredits(sub);
    return;
  }
  // Free credits go only to confirmed emails, so throwaway accounts can't farm them.
  if (verificationRequired()) {
    const user = await one<{ verified_at: number }>("SELECT verified_at FROM users WHERE id = ?", [userId]);
    if (!Number(user?.verified_at)) return;
  }
  const ref = `free:${userId}:${monthKey()}`;
  if (await one("SELECT 1 FROM credit_ledger WHERE ref = ?", [ref])) return;
  const topUp = Math.max(0, FREE_MONTHLY_CREDITS - (await balance(userId)));
  await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, topUp, "Monthly free credits", ref, now()],
  );
}

/**
 * Takes credits only if a balance covers them: a team member's shared pool first, then their
 * own. Each ledger's check and insert are one statement, so parallel requests (several team
 * members at once) can't take a balance below zero. Returns the ledger entry's id, or null when
 * no balance covers the amount. Pass the id to settle() to lower the charge once the real cost is known.
 */
export async function charge(userId: string, amount: number, reason: string): Promise<number | null> {
  if (amount <= 0) return 0;
  for (const account of await spendAccounts(userId)) {
    const r = await run(
      `INSERT INTO credit_ledger (user_id, amount, reason, actor, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?) >= ?`,
      [account, -amount, reason, account === userId ? null : userId, now(), account, amount],
    );
    if (r.rowsAffected === 1) return Number(r.lastInsertRowid);
  }
  return null;
}

/** Lowers a held charge to what the request really used (never raises it). */
export async function settle(chargeId: number, used: number): Promise<void> {
  if (!chargeId) return;
  await run("UPDATE credit_ledger SET amount = MAX(amount, ?) WHERE id = ?", [-Math.max(0, used), chargeId]);
}

/** Logs one request for the owner dashboard. */
export async function logUsage(entry: {
  userId: string;
  engine: string;
  model: string;
  provider: string;
  credits: number;
  costCents: number;
  ok: boolean;
}): Promise<void> {
  await run(
    "INSERT INTO usage (user_id, engine, model, provider, credits, cost_cents, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [entry.userId, entry.engine, entry.model, entry.provider, entry.credits, entry.costCents, entry.ok ? 1 : 0, now()],
  );
}

export async function refund(userId: string, amount: number, reason: string): Promise<void> {
  if (amount <= 0) return;
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)", [
    userId,
    amount,
    reason,
    now(),
  ]);
}

/** Adds a purchased pack once per payment reference (webhooks can be delivered twice). */
export async function addPurchase(userId: string, packId: string, ref: string, paymentIntent: string | null = null): Promise<boolean> {
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) return false;
  const r = await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, pack.credits, `Bought ${pack.name} pack`, ref, now()],
  );
  if (r.rowsAffected !== 1) return false;
  await run(
    "INSERT OR IGNORE INTO purchases (user_id, pack, credits, amount_cents, test, ref, payment_intent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [userId, pack.id, pack.credits, pack.priceCents, ref.startsWith("stripe:") ? 0 : 1, ref, paymentIntent, now()],
  );
  return true;
}

export type Purchase = {
  user_id: string;
  // A pack id, or plan:<plan>:<interval>.
  pack: string;
  credits: number;
  ref: string;
  subscription: string | null;
  created_at: number;
};

/** The purchase a payment paid for, by its payment intent or by its own reference. */
export async function findPurchase(by: { paymentIntent?: string | null; ref?: string | null }): Promise<Purchase | null> {
  const cols = "user_id, pack, credits, ref, subscription, created_at";
  if (by.paymentIntent) {
    const row = await one<Purchase>(`SELECT ${cols} FROM purchases WHERE payment_intent = ?`, [by.paymentIntent]);
    if (row) return row;
  }
  return by.ref ? one<Purchase>(`SELECT ${cols} FROM purchases WHERE ref = ?`, [by.ref]) : null;
}

/** The credits a purchase has given so far: a pack's credits, or each month a plan payment paid for. */
async function grantedFor(p: Purchase): Promise<number> {
  if (!p.pack.startsWith("plan:")) return p.credits;
  if (!p.pack.endsWith(":year") || !p.subscription) return p.credits;
  // A yearly payment gives credits month by month, so count the months given since it was paid.
  const row = await one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM credit_ledger WHERE ref LIKE ? AND created_at >= ? AND amount > 0",
    [`plan:${p.subscription}:%`, p.created_at],
  );
  return p.credits * Math.min(12, Math.max(1, Number(row?.n ?? 0)));
}

/**
 * Takes back the credits a refunded or disputed payment gave: share (0 to 1) of them, minus
 * what was already taken back for the same charge. The balance can reach 0 but never goes
 * below it. Safe to run twice: ref is unique, and earlier take-backs for the charge are counted.
 * Returns the credits taken.
 */
export async function clawBack(p: Purchase, share: number, charge: string, ref: string, reason: string): Promise<number> {
  const target = Math.round((await grantedFor(p)) * Math.min(1, Math.max(0, share)));
  const taken = await one<{ total: number }>(
    "SELECT COALESCE(-SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ? AND (ref LIKE ? OR ref LIKE ?)",
    [p.user_id, `stripe-refund:${charge}:%`, `stripe-dispute:%:${charge}`],
  );
  const amount = Math.min(target - Number(taken?.total ?? 0), await balance(p.user_id));
  if (amount <= 0) return 0;
  const r = await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [p.user_id, -amount, reason, ref, now()],
  );
  return r.rowsAffected === 1 ? amount : 0;
}

/** The latest credit changes: the user's own and what they spent from a team pool (owners see who spent it). */
export async function recentActivity(userId: string, limit = 20) {
  return all<{ amount: number; reason: string; created_at: number }>(
    `SELECT l.amount, l.created_at,
       CASE WHEN l.actor IS NULL THEN l.reason
            WHEN l.actor = ? THEN l.reason || ' (team credits)'
            ELSE l.reason || ' by ' || COALESCE(NULLIF(u.name, ''), u.email, 'a former member') END AS reason
     FROM credit_ledger l LEFT JOIN users u ON u.id = l.actor
     WHERE (l.user_id = ? OR l.actor = ?) AND l.amount != 0 ORDER BY l.id DESC LIMIT ?`,
    [userId, userId, userId, limit],
  );
}
