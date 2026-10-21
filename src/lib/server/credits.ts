import { CREDIT_PACKS, FREE_MONTHLY_CREDITS } from "../credits.ts";
import { all, one, run, now } from "./db.ts";
import { activeSubscription, grantPlanCredits } from "./subscriptions.ts";
import { verificationRequired } from "./email.ts";
import { teamPool } from "./teams.ts";
import { releaseReferralBonuses } from "./referrals.ts";
import { watchBalance, watchRefusal } from "./low-balance.ts";
import { paymentsEnabled } from "./stripe.ts";

/*
 * Who started a spend, for charge() and settle(). visitor: someone using the account holder's
 * published app (its AI, window.flashAI), not the account holder. Such a spend never sets off the
 * account's auto top-up (see low-balance.ts): a pack is only bought for what the person does.
 * keepTopUpLevel: the charge must leave each balance at or above its auto top-up level while auto
 * top-up can buy a pack (see TOP_UP_LEVEL). Such spending isn't the account holder's own either, so
 * it never sets off a top-up, as for a visitor.
 */
type SpendBy = { visitor?: boolean; keepTopUpLevel?: boolean };

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

/*
 * SQL for an account's auto top-up level (the account is its one parameter): the level while auto
 * top-up can buy a pack (on, with a saved card and a pack Flash sells, and no disputed payment, as
 * maybeAutoTopUp asks; payments on, see keepsLevel), else 0. Under it, the next /api/me or chat reply
 * buys the pack the person picked, so spending the person didn't start themselves (an app's AI that
 * visitors ask, keepTopUpLevel) stops at it instead. A month's last top-up used, or one a few minutes
 * ago, only holds a pack back for a while, so the level is still kept then.
 */
const TOP_UP_LEVEL = `COALESCE((SELECT a.below FROM auto_topups a WHERE a.user_id = ? AND a.enabled = 1 AND a.payment_method IS NOT NULL
  AND a.pack IN (${CREDIT_PACKS.map((p) => `'${p.id}'`).join(", ")})
  AND NOT EXISTS (SELECT 1 FROM credit_ledger d WHERE d.user_id = a.user_id AND substr(d.ref, 1, 15) = 'stripe-dispute:')), 0)`;

// With payments off, auto top-up never buys anything, so there is no level to keep.
const keepsLevel = (keepTopUpLevel: boolean) => keepTopUpLevel && paymentsEnabled();

/** An account's auto top-up level while auto top-up can buy a pack (see TOP_UP_LEVEL), else 0. */
export async function topUpLevel(account: string): Promise<number> {
  if (!keepsLevel(true)) return 0;
  return Number((await one<{ level: number }>(`SELECT ${TOP_UP_LEVEL} AS level`, [account]))?.level ?? 0);
}

/** A balance, less the auto top-up level while auto top-up is on: what can be spent without buying a pack. */
async function aboveTopUpLevel(account: string): Promise<number> {
  const row = await one<{ room: number }>(
    `SELECT COALESCE(SUM(amount), 0) - ${TOP_UP_LEVEL} AS room FROM credit_ledger WHERE user_id = ?`,
    [account, account],
  );
  return Number(row?.room ?? 0);
}

/**
 * What a user can spend: the most one request can hold (one ledger pays for each request) and
 * the total to show, the team pool included. keepTopUpLevel: only what is above each ledger's
 * auto top-up level counts (see charge).
 */
export async function spendable(
  userId: string,
  { keepTopUpLevel = false, accounts: known }: { keepTopUpLevel?: boolean; accounts?: Promise<string[]> } = {},
): Promise<{ largest: number; total: number; pool: number | null }> {
  // known: spendAccounts(userId), asked for earlier by a caller that had other reads to make meanwhile.
  const accounts = await (known ?? spendAccounts(userId));
  const balances = await Promise.all(accounts.map(keepsLevel(keepTopUpLevel) ? aboveTopUpLevel : balance));
  return {
    largest: Math.max(...balances),
    total: balances.reduce((a, b) => a + b, 0),
    pool: accounts.length > 1 ? balances[0] : null,
  };
}

// Longer than any request runs (the chat route's maxDuration is 800 seconds).
export const HOLD_MINUTES = 15;

/**
 * The balance auto top-up compares with its level (see maybeAutoTopUp): every spend once settled, the
 * account holder's or a visitor's. Only a visitor's hold still open (keepTopUpLevel, see charge) is
 * left out: most of it comes back when the answer ends, and one a stopped server left open, however
 * old, is settled to 0 later (see settleLeftHolds in site-ai.ts). A visitor's spend never sets off a
 * top-up itself (settle and charge don't let it try), so one that settled below the level (auto
 * top-up turned on, or its level raised, while it ran) is bought for on the account holder's own next
 * spend or visit, like any balance below the level they picked.
 */
export async function topUpBalance(userId: string): Promise<number> {
  const row = await one<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger
     WHERE user_id = ? AND NOT (keeps_level > 0 AND settled_at = 0)`,
    [userId],
  );
  return Number(row?.total ?? 0);
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
  const ref = `free:${userId}:${monthKey()}`;
  // What decides the grants, read together: this runs before every chat reply, and one read after
  // another kept the answer waiting. None of them reads what the grants below write.
  const [pool, sub, inDispute, given] = await Promise.all([
    teamPool(userId),
    activeSubscription(userId),
    disputed(userId),
    one("SELECT 1 FROM credit_ledger WHERE ref = ?", [ref]),
  ]);
  // A team member's shared pool gets its monthly credits too (each grant is backed by a payment).
  if (pool) await grantPlanCredits(pool);
  if (sub) {
    await grantPlanCredits(sub);
    return;
  }
  // No free credits for an account that disputed a payment: they'd only pay off its debt.
  if (inDispute) return;
  // Free credits go only to confirmed emails, so throwaway accounts can't farm them.
  if (verificationRequired()) {
    const user = await one<{ verified_at: number }>("SELECT verified_at FROM users WHERE id = ?", [userId]);
    if (!Number(user?.verified_at)) return;
  }
  if (given) return;
  // Credits held by a request still running count as not spent yet: most of a hold comes back when
  // the reply ends, so counting it as spent would top up past the monthly amount. A visitor's hold
  // (keeps_level > 0) counts so however old: one a stopped server left is settled to 0 later (see
  // settleLeftHolds in site-ai.ts).
  const row = await one<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger
     WHERE user_id = ? AND NOT (amount < 0 AND ref IS NULL AND settled_at = 0 AND (keeps_level > 0 OR created_at > ?))`,
    [userId, now() - HOLD_MINUTES * 60_000],
  );
  const topUp = Math.max(0, FREE_MONTHLY_CREDITS - Math.max(0, Number(row?.total ?? 0)));
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
 * keepTopUpLevel: each balance must stay at or above its own auto top-up level while auto top-up
 * can buy a pack (see TOP_UP_LEVEL), in the same statement, so the charge can never make Flash buy one.
 * A refusal settles nothing, so it is where a low-credit email still owed goes, the out-of-credits
 * email once the balance is at or below 0, and where auto top-up tries again (see low-balance.ts),
 * except for a visitor's spend.
 */
export async function charge(
  userId: string,
  amount: number,
  reason: string,
  { visitor = false, keepTopUpLevel = false }: SpendBy = {},
): Promise<number | null> {
  if (amount <= 0) return 0;
  const keep = keepsLevel(keepTopUpLevel);
  const accounts = await spendAccounts(userId);
  for (const account of accounts) {
    const r = await run(
      `INSERT INTO credit_ledger (user_id, amount, reason, actor, keeps_level, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?) >= ?${keep ? ` + ${TOP_UP_LEVEL}` : ""}`,
      [account, -amount, reason, account === userId ? null : userId, keepTopUpLevel ? 1 : 0, now(), account, amount, ...(keep ? [account] : [])],
    );
    if (r.rowsAffected === 1) return Number(r.lastInsertRowid);
  }
  // Spending that keeps the level isn't the account holder's own either, so it never tries a top-up,
  // nor sends the out-of-credits email: an app's AI refusing visitors has its own (see low-balance.ts).
  const own = !visitor && !keepTopUpLevel;
  watchRefusal(accounts, { topUp: own, out: own });
  return null;
}

/**
 * Lowers a held charge to what the request really used (never raises it). Every spend is settled, so
 * this is where a balance falling below someone's low-credit level is noticed (see low-balance.ts),
 * after the response.
 */
export async function settle(chargeId: number, used: number, { visitor = false, keepTopUpLevel = false }: SpendBy = {}): Promise<void> {
  if (!chargeId) return;
  const r = await run("UPDATE credit_ledger SET amount = MAX(amount, ?), settled_at = ? WHERE id = ? RETURNING user_id, amount", [
    -Math.max(0, used),
    now(),
    chargeId,
  ]);
  const row = r.rows[0];
  if (row) watchBalance(String(row.user_id), -Number(row.amount), { topUp: !visitor && !keepTopUpLevel });
}

/**
 * What a request the user made was finally charged, in credits, or null while it is still held
 * (or the charge isn't theirs). A team member's charge on the shared pool is theirs too.
 */
export async function settledCharge(userId: string, chargeId: number): Promise<number | null> {
  const row = await one<{ amount: number; settled_at: number }>(
    "SELECT amount, settled_at FROM credit_ledger WHERE id = ? AND (user_id = ? OR actor = ?) AND amount <= 0",
    [chargeId, userId, userId],
  );
  return row && Number(row.settled_at) ? -Number(row.amount) : null;
}

export type UsagePart = { provider: string; model: string; cents: number };

/**
 * Logs one request for the owner dashboard. parts lists what each provider cost on the way (a
 * Claude helper that planned a picture, say): every provider and model other than the main one
 * gets its own row, so the dashboard shows each provider's bill, and the main row keeps the rest.
 */
export async function logUsage(entry: {
  userId: string;
  engine: string;
  model: string;
  provider: string;
  credits: number;
  costCents: number;
  ok: boolean;
  parts?: UsagePart[];
}): Promise<void> {
  const others = new Map<string, UsagePart>();
  for (const p of entry.parts ?? []) {
    if (!p.cents || (p.provider === entry.provider && p.model === entry.model)) continue;
    const key = `${p.provider}\n${p.model}`;
    const seen = others.get(key);
    others.set(key, { ...p, cents: (seen?.cents ?? 0) + p.cents });
  }
  const helpers = [...others.values()];
  const mainCents = Math.max(0, entry.costCents - helpers.reduce((sum, p) => sum + p.cents, 0));
  const at = now();
  const insert = "INSERT INTO usage (user_id, engine, model, provider, credits, cost_cents, ok, part, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const ok = entry.ok ? 1 : 0;
  await run(insert, [entry.userId, entry.engine, entry.model, entry.provider, entry.credits, mainCents, ok, 0, at]);
  for (const p of helpers) await run(insert, [entry.userId, entry.engine, p.model, p.provider, 0, p.cents, ok, 1, at]);
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
  // 1 for a Stripe test-mode or demo payment.
  test?: number;
};

/** The purchase a payment paid for, by its payment intent or by its own reference. */
export async function findPurchase(by: { paymentIntent?: string | null; ref?: string | null }): Promise<Purchase | null> {
  const cols = "user_id, pack, credits, ref, subscription, created_at, test";
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

/** Whether an account has disputed a payment (its take-back is in the ledger as stripe-dispute:…). */
export async function disputed(userId: string): Promise<boolean> {
  return !!(await one("SELECT 1 FROM credit_ledger WHERE user_id = ? AND substr(ref, 1, 15) = 'stripe-dispute:' LIMIT 1", [userId]));
}

/**
 * Takes back the credits a refunded or disputed payment gave: share (0 to 1) of them, minus
 * what was already taken back for the same charge. For a refund the balance can reach 0 but
 * never goes below it. For a dispute (debt) it can: credits already spent become a debt, a
 * balance below 0, so nothing can be spent until a later payment covers it. Safe to run twice:
 * ref is unique, and earlier take-backs for the charge are counted. Returns the credits taken.
 */
export async function clawBack(p: Purchase, share: number, charge: string, ref: string, reason: string, debt = false): Promise<number> {
  const target = Math.round((await grantedFor(p)) * Math.min(1, Math.max(0, share)));
  const taken = await one<{ total: number }>(
    "SELECT COALESCE(-SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ? AND (ref LIKE ? OR ref LIKE ?)",
    [p.user_id, `stripe-refund:${charge}:%`, `stripe-dispute:%:${charge}`],
  );
  const owed = target - Number(taken?.total ?? 0);
  const amount = debt ? Math.max(0, owed) : Math.min(owed, await balance(p.user_id));
  // A dispute is always written down, even with nothing left to take, so disputed() sees it.
  if (amount <= 0 && !debt) return 0;
  const r = await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [p.user_id, -amount, reason, ref, now()],
  );
  return r.rowsAffected === 1 ? amount : 0;
}

/**
 * Records money that went back to a buyer, for the owner's net profit: total is how much of the
 * charge has gone back so far (Stripe's amount_refunded, or the disputed amount), and each event
 * (ref) is counted once, adding only what it newly took back.
 */
export async function recordReversal(p: Purchase, kind: "refund" | "dispute", charge: string, total: number, ref: string) {
  const before = await one<{ total: number }>(
    "SELECT COALESCE(MAX(total_cents), 0) AS total FROM payment_reversals WHERE charge = ? AND kind = ?",
    [charge, kind],
  );
  const amount = Math.max(0, Math.round(total) - Number(before?.total ?? 0));
  await run(
    `INSERT OR IGNORE INTO payment_reversals (ref, charge, kind, total_cents, amount_cents, test, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ref, charge, kind, Math.max(Math.round(total), Number(before?.total ?? 0)), amount, Number(p.test ?? 0) ? 1 : 0, now()],
  );
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
