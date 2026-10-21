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

/** How long after it settled auto top-up may leave out a charge marked when its level went up (see topUpBalance). */
export const KEPT_OUT_MS = 86_400_000;

/**
 * The balance auto top-up compares with its level: an automation's open hold (auto:…) counts as not
 * spent, as the free monthly credits count it. It is held at its worst case and settled for sure,
 * mostly far lower, and automations already keep the balance above the level with their holds at full
 * size (chargeOnce), so an open hold never sets off a top-up; once it settles, the next check sees
 * what it cost. Nor, settled or not, does the charge of a step that was running when the level went up
 * (topup_kept_from, see autoHoldsKeptOut): it was kept above the lower level, so it may settle below the
 * new one. That lasts only while the balance is at least what it was then, with every hold at its full
 * size (such a step only gives credits back from there, so a balance under that was spent by the account
 * itself), until the balance is back at the level, and for at most a day after it settled (KEPT_OUT_MS):
 * a balance the account can't spend from (one too small for any answer) would otherwise keep auto top-up
 * from ever buying. The marks are cleared here then (one statement that reads both as they are), and
 * every charge counts again.
 */
export async function topUpBalance(userId: string): Promise<number> {
  const lapsed = now() - KEPT_OUT_MS;
  const row = await one<{ counted: number; marked: number }>(
    `SELECT COUNT(l.topup_kept_from) AS marked,
            COALESCE(SUM(CASE WHEN l.amount < 0 AND l.ref LIKE 'auto:%' AND (l.settled_at = 0 OR (l.topup_kept_from <= b.total AND l.settled_at > ?)) THEN 0 ELSE l.amount END), 0) AS counted
       FROM (SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ?) b
       LEFT JOIN credit_ledger l ON l.user_id = ?`,
    [lapsed, userId, userId],
  );
  if (Number(row?.marked ?? 0) > 0) {
    await run(
      `UPDATE credit_ledger SET topup_kept_from = NULL
        WHERE user_id = ? AND topup_kept_from IS NOT NULL
          AND ((settled_at > 0 AND settled_at <= ?)
               OR (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?)
                  >= (SELECT below FROM auto_topups WHERE user_id = ? AND enabled = 1 AND payment_method IS NOT NULL))`,
      [userId, lapsed, userId, userId],
    );
  }
  return Number(row?.counted ?? 0);
}

/**
 * Sent in the same batch as a write that turns auto top-up on, sets its level or saves its card, before
 * it: `level` is the level that write leaves in force (0 when it leaves auto top-up off or without a
 * card), or "saved" for the level already saved (a card saved turns auto top-up on at it). Only when that
 * is above the level in force until now (0 when off or without a card), auto top-up goes by the balance
 * as it is now: the marks from before are cleared, and when the balance, every hold at its full size, is
 * under the new level, the automation holds open now are marked with it (topup_kept_from), so auto top-up
 * leaves their charges out, settled or not, while the balance is at least that, until it is back at the
 * level (see topUpBalance): each was kept above the lower level, so it may settle below the new one. A
 * save that keeps or lowers the level (a pack or a card changed, the same choice again, auto top-up off)
 * changes no mark. One batch is one transaction, so the level before is read as it was, no hold settles
 * or is charged in between, and a charge after it is checked against the new level (chargeOnce). The
 * open holds are read through credit_holds_open (an open hold's lease_until is never 0).
 */
export function autoHoldsKeptOut(userId: string, level: number | "saved"): { sql: string; args: (string | number)[] }[] {
  const to = level === "saved" ? { sql: "(SELECT below FROM auto_topups WHERE user_id = ?)", args: [userId] } : { sql: "?", args: [level] };
  const raised = {
    sql: `${to.sql} > COALESCE((SELECT below FROM auto_topups WHERE user_id = ? AND enabled = 1 AND payment_method IS NOT NULL), 0)`,
    args: [...to.args, userId],
  };
  const total = "(SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?)";
  return [
    { sql: `UPDATE credit_ledger SET topup_kept_from = NULL WHERE user_id = ? AND topup_kept_from IS NOT NULL AND ${raised.sql}`, args: [userId, ...raised.args] },
    {
      sql: `UPDATE credit_ledger SET topup_kept_from = ${total}
             WHERE ref IN (SELECT ref FROM credit_holds WHERE settled_at = 0 AND lease_until > 0 AND user_id = ?)
               AND ${raised.sql} AND ${total} < ${to.sql}`,
      args: [userId, userId, ...raised.args, userId, ...to.args],
    },
  ];
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

// Longer than any request runs (the chat route's maxDuration is 800 seconds).
export const HOLD_MINUTES = 15;

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
  // No free credits for an account that disputed a payment: they'd only pay off its debt.
  if (await disputed(userId)) return;
  // Free credits go only to confirmed emails, so throwaway accounts can't farm them.
  if (verificationRequired()) {
    const user = await one<{ verified_at: number }>("SELECT verified_at FROM users WHERE id = ?", [userId]);
    if (!Number(user?.verified_at)) return;
  }
  const ref = `free:${userId}:${monthKey()}`;
  if (await one("SELECT 1 FROM credit_ledger WHERE ref = ?", [ref])) return;
  // Credits held by a request still running count as not spent yet: most of a hold comes back when
  // the reply ends, so counting it as spent would top up past the monthly amount. An automation's hold
  // (auto:…) counts as not spent however old it is: a tick that stopped can leave one open for longer,
  // and each one is settled for sure (see credit-holds.ts). (Each side names ref IS [NOT] NULL: a NULL
  // inside NOT would leave the row out of the sum.)
  const row = await one<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger
     WHERE user_id = ? AND NOT (amount < 0 AND settled_at = 0 AND ((ref IS NULL AND created_at > ?) OR (ref IS NOT NULL AND ref LIKE 'auto:%')))`,
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

/** What an automation's charges came to since a moment (its holds at full size until settled). */
export async function automationSpent(automationId: string, since: number): Promise<number> {
  const row = await one<{ total: number }>(
    `SELECT COALESCE(-SUM(amount), 0) AS total FROM credit_ledger
     WHERE automation_id = ? AND automation_id <> '' AND amount < 0 AND created_at >= ?`,
    [automationId, since],
  );
  return Number(row?.total ?? 0);
}

/** The balance an account keeps for its auto top-up: its level while auto top-up is on with a card, else 0. */
export async function topUpFloor(account: string): Promise<number> {
  const row = await one<{ below: number }>("SELECT below FROM auto_topups WHERE user_id = ? AND enabled = 1 AND payment_method IS NOT NULL", [account]);
  return Math.max(0, Number(row?.below ?? 0));
}

export type ChargeOnce = { id: number; replay: boolean } | { refused: "credits" | "topup_floor" | "month" | "day" | "hold" | "changed" };

/**
 * Takes an automation step's credits from exactly one account, once per ref, in one statement (so
 * parallel runs, team members and chat requests can't take a balance below zero or a limit past it):
 * - only from account (the automation's paying account), never falling through to another;
 * - never below the account's auto top-up level when keepTopUpLevel (holds count at full size until
 *   settled), so automation spending can never set off auto top-up (see auto-topup.ts);
 * - never past the automation's month limit, nor its day limit when it has one: its charges since
 *   monthStart (and dayStart) plus this one;
 * - with hold, only while the credit hold with the same ref is still open (see credit-holds.ts), so a
 *   step that stalled while the reaper settled its hold can't take credits afterwards.
 * A ref that is already in the ledger isn't charged again: its row comes back as a replay. Otherwise,
 * when nothing was taken, it says which rule refused. When none does any more (another request
 * settled between the refusal and the reads), it is tried once more, then "changed": nothing was
 * taken, and the caller tries again later.
 */
export async function chargeOnce(o: {
  account: string;
  actor: string;
  amount: number;
  reason: string;
  ref: string;
  automationId: string;
  monthCap: number;
  monthStart: number;
  dayCap?: number;
  dayStart?: number;
  keepTopUpLevel: boolean;
  hold?: boolean;
}): Promise<ChargeOnce> {
  const amount = Math.max(1, Math.ceil(o.amount));
  const keep = o.keepTopUpLevel ? 1 : 0;
  const hold = o.hold ? 1 : 0;
  const dayCap = o.dayCap ?? 0;
  const dayStart = o.dayStart ?? 0;
  const insert = () => run(
    `INSERT INTO credit_ledger (user_id, amount, reason, ref, actor, automation_id, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?)
           - CASE WHEN ? = 1 THEN COALESCE((SELECT below FROM auto_topups
                    WHERE user_id = ? AND enabled = 1 AND payment_method IS NOT NULL), 0) ELSE 0 END >= ?
       AND (SELECT COALESCE(-SUM(amount), 0) FROM credit_ledger
             WHERE automation_id = ? AND automation_id <> '' AND amount < 0 AND created_at >= ?) + ? <= ?
       AND (? = 0 OR (SELECT COALESCE(-SUM(amount), 0) FROM credit_ledger
             WHERE automation_id = ? AND automation_id <> '' AND amount < 0 AND created_at >= ?) + ? <= ?)
       AND (? = 0 OR EXISTS (SELECT 1 FROM credit_holds WHERE ref = ? AND settled_at = 0))
     ON CONFLICT(ref) WHERE ref IS NOT NULL DO NOTHING`,
    [
      o.account,
      -amount,
      o.reason,
      o.ref,
      // As charge() writes it: an actor only when someone other than the account's owner spent it.
      o.actor === o.account ? null : o.actor,
      o.automationId,
      now(),
      o.account,
      keep,
      o.account,
      amount,
      o.automationId,
      o.monthStart,
      amount,
      o.monthCap,
      dayCap,
      o.automationId,
      dayStart,
      amount,
      dayCap,
      hold,
      o.ref,
    ],
  );
  for (let attempt = 0; ; attempt++) {
    const r = await insert();
    if (r.rowsAffected === 1) return { id: Number(r.lastInsertRowid), replay: false };
    const seen = await one<{ id: number }>("SELECT id FROM credit_ledger WHERE ref = ?", [o.ref]);
    if (seen) return { id: Number(seen.id), replay: true };
    if (o.hold && !(await one("SELECT 1 FROM credit_holds WHERE ref = ? AND settled_at = 0", [o.ref]))) return { refused: "hold" };
    const held = await balance(o.account);
    if (held < amount) return { refused: "credits" };
    if (o.keepTopUpLevel && held - (await topUpFloor(o.account)) < amount) return { refused: "topup_floor" };
    if ((await automationSpent(o.automationId, o.monthStart)) + amount > o.monthCap) return { refused: "month" };
    if (dayCap > 0 && (await automationSpent(o.automationId, dayStart)) + amount > dayCap) return { refused: "day" };
    if (attempt >= 1) return { refused: "changed" };
  }
}

/** Lowers a held charge to what the request really used (never raises it). */
export async function settle(chargeId: number, used: number): Promise<void> {
  if (!chargeId) return;
  await run("UPDATE credit_ledger SET amount = MAX(amount, ?), settled_at = ? WHERE id = ?", [-Math.max(0, used), now(), chargeId]);
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
  // The automation the request ran for, if any (see automation-steps.ts).
  automationId?: string;
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
  const insert = "INSERT INTO usage (user_id, engine, model, provider, credits, cost_cents, ok, part, automation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const ok = entry.ok ? 1 : 0;
  const automation = entry.automationId ?? "";
  await run(insert, [entry.userId, entry.engine, entry.model, entry.provider, entry.credits, mainCents, ok, 0, automation, at]);
  for (const p of helpers) await run(insert, [entry.userId, entry.engine, p.model, p.provider, 0, p.cents, ok, 1, automation, at]);
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
