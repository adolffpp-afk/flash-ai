import { REFERRAL_PENDING_DAYS, earnsReferral, referralBonus } from "../credits.ts";
import { balance, type Purchase } from "./credits.ts";
import { all, db, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";

/*
 * Referral links. A visitor who arrives on /?ref=<code> keeps the code in a cookie, and sign-up
 * records who referred them (once, never the same inbox). Nobody earns anything until the
 * friend first pays for a plan (REFERRAL_EARNS says which plans and intervals count; credit packs
 * never do), so fake accounts are worth nothing. The friend's bonus comes at once; the
 * referrer's is pending for REFERRAL_PENDING_DAYS and becomes spendable only after that
 * (releaseReferralBonuses), so a refund or dispute in that time cancels it before it can be spent.
 * The rule and its numbers live in credits.ts (REFERRAL_EARNS, referralBonus), where the pricing
 * tests check them.
 */
export const REF_COOKIE = "flash_ref";
/** Set-Cookie value that forgets the referral code once an account exists. */
export const CLEAR_REF_COOKIE = `${REF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
const CODE = /^[A-Za-z0-9_-]{4,32}$/;

/** The user's referral code, made on first use. */
export async function referralCode(userId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const row = await one<{ ref_code: string | null }>("SELECT ref_code FROM users WHERE id = ?", [userId]);
    if (row?.ref_code) return row.ref_code;
    await run("UPDATE users SET ref_code = ? WHERE id = ? AND ref_code IS NULL", [randomId(6), userId]).catch(() => {});
  }
  throw new Error("Couldn't make a referral code");
}

/** Who a referral code belongs to, unless it is the new account's own inbox. */
export async function referrerFor(code: string | null | undefined, newEmailKey: string): Promise<string | null> {
  if (!code || !CODE.test(code)) return null;
  const row = await one<{ id: string; email_key: string }>("SELECT id, email_key FROM users WHERE ref_code = ?", [code]);
  return row && row.email_key !== newEmailKey ? row.id : null;
}

const FRIEND_REF = (friendId: string) => `referral:friend:${friendId}`;
const DAY = 24 * 3600_000;
const REFERRER_PREFIX = "referral:referrer:";
const REFERRER_REF = (friendId: string) => `${REFERRER_PREFIX}${friendId}`;

/**
 * Gives the referral bonuses if this purchase is the referred user's first real (Stripe) payment
 * of a plan that counts (earnsReferral; credit packs never do, and packs bought before don't stop
 * a later plan from earning): the friend's at once, the referrer's as a pending reward that
 * releaseReferralBonuses() credits after REFERRAL_PENDING_DAYS. Renewals earn nothing more. Safe to
 * run twice: one reward per friend, and every ledger entry has a unique ref. Returns whether
 * bonuses were given.
 */
export async function rewardReferral(purchaseRef: string, at = now()): Promise<boolean> {
  const p = await one<{ id: number; user_id: string; pack: string; credits: number; test: number; referred_by: string | null }>(
    `SELECT p.id, p.user_id, p.pack, p.credits, p.test, u.referred_by
     FROM purchases p JOIN users u ON u.id = p.user_id WHERE p.ref = ?`,
    [purchaseRef],
  );
  if (!p || Number(p.test) || !earnsReferral(p.pack) || !p.referred_by || p.referred_by === p.user_id) return false;
  // Only the first payment that counts: a renewal, or a later plan, earns nothing.
  const earlier = await all<{ pack: string }>("SELECT pack FROM purchases WHERE user_id = ? AND test = 0 AND id < ?", [
    p.user_id,
    p.id,
  ]);
  if (earlier.some((e) => earnsReferral(e.pack))) return false;
  if (!(await one("SELECT 1 FROM users WHERE id = ?", [p.referred_by]))) return false;
  const bonus = referralBonus(Number(p.credits));
  // The friend's bonus goes in only alongside this purchase's reward, in one transaction, and
  // its ref is unique, so running again adds nothing.
  const [reward] = await (await db()).batch(
    [
      {
        sql: `INSERT OR IGNORE INTO referral_rewards
                (friend_id, referrer_id, purchase_ref, friend_credits, referrer_credits, created_at, referrer_available_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [p.user_id, p.referred_by, purchaseRef, bonus.friend, bonus.referrer, at, at + REFERRAL_PENDING_DAYS * DAY],
      },
      {
        sql: `INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) SELECT ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM referral_rewards WHERE friend_id = ? AND purchase_ref = ?)`,
        args: [p.user_id, bonus.friend, "Referral bonus: extra credits on your plan", FRIEND_REF(p.user_id), at,
          p.user_id, purchaseRef],
      },
    ],
    "write",
  );
  return reward.rowsAffected === 1;
}

/**
 * Credits a referrer's pending bonuses whose waiting time is over and that no refund or dispute
 * cancelled. Runs whenever credits are checked (ensureMonthlyCredits). Safe to run any number of
 * times: each bonus's ledger ref is unique. Returns how many bonuses it released.
 */
export async function releaseReferralBonuses(referrerId: string, at = now()): Promise<number> {
  // A read first, so the usual case (nothing due) writes nothing.
  const due = await one(
    `SELECT 1 FROM referral_rewards r
     WHERE referrer_id = ? AND cancelled_at = 0 AND referrer_available_at <= ?
       AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE ref = ? || r.friend_id)`,
    [referrerId, at, REFERRER_PREFIX],
  );
  if (!due) return 0;
  const r = await run(
    `INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at)
     SELECT referrer_id, referrer_credits, ?, ? || friend_id, ? FROM referral_rewards
     WHERE referrer_id = ? AND cancelled_at = 0 AND referrer_available_at <= ?`,
    ["Referral bonus: a friend you invited subscribed to a plan", REFERRER_PREFIX, at, referrerId, at],
  );
  return r.rowsAffected;
}

/**
 * Takes back share (0 to 1) of the referral bonuses a refunded or disputed payment gave, minus
 * what earlier refunds of it already took. Like clawBack(), balances stop at zero and the same
 * event can't take twice (eventRef is part of each entry's unique ref).
 */
export async function reverseReferral(purchase: Purchase, share: number, eventRef: string, reason: string): Promise<number> {
  const reward = await one<{ friend_id: string; referrer_id: string; friend_credits: number; referrer_credits: number }>(
    "SELECT friend_id, referrer_id, friend_credits, referrer_credits FROM referral_rewards WHERE purchase_ref = ?",
    [purchase.ref],
  );
  if (!reward) return 0;
  let total = 0;
  const sides = [{ side: "friend", userId: reward.friend_id, credits: Number(reward.friend_credits) }];
  // A referrer's bonus still pending is cancelled outright (any refund or dispute of the payment
  // does it); only a bonus already released is taken back like the friend's.
  await run(
    `UPDATE referral_rewards SET cancelled_at = ? WHERE friend_id = ? AND cancelled_at = 0
       AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE ref = ?)`,
    [now(), reward.friend_id, REFERRER_REF(reward.friend_id)],
  );
  if (await one("SELECT 1 FROM credit_ledger WHERE ref = ?", [REFERRER_REF(reward.friend_id)])) {
    sides.push({ side: "referrer", userId: reward.referrer_id, credits: Number(reward.referrer_credits) });
  }
  for (const { side, userId, credits } of sides) {
    const prefix = `referral-back:${side}:${reward.friend_id}:`;
    const target = Math.round(credits * Math.min(1, Math.max(0, share)));
    const taken = await one<{ total: number }>(
      "SELECT COALESCE(-SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ? AND substr(ref, 1, ?) = ?",
      [userId, prefix.length, prefix],
    );
    const amount = Math.min(target - Number(taken?.total ?? 0), await balance(userId));
    if (amount <= 0) continue;
    const r = await run(
      "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
      [userId, -amount, `Referral bonus taken back: ${reason.toLowerCase()}`, `${prefix}${eventRef}`, now()],
    );
    if (r.rowsAffected === 1) total += amount;
  }
  return total;
}

/** The numbers on the Invite friends panel. */
export async function referralStats(userId: string) {
  const prefixes = [REFERRER_PREFIX, "referral-back:referrer:"];
  const row = await one<{ joined: number; rewarded: number; earned: number }>(
    `SELECT (SELECT COUNT(*) FROM users WHERE referred_by = ?) AS joined,
            (SELECT COUNT(*) FROM credit_ledger WHERE user_id = ? AND substr(ref, 1, ?) = ?) AS rewarded,
            (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?
               AND (substr(ref, 1, ?) = ? OR substr(ref, 1, ?) = ?)) AS earned`,
    [userId, userId, prefixes[0].length, prefixes[0], userId, prefixes[0].length, prefixes[0], prefixes[1].length, prefixes[1]],
  );
  // Bonuses still waiting out their REFERRAL_PENDING_DAYS, soonest first.
  const pending = await all<{ credits: number; available_at: number }>(
    `SELECT referrer_credits AS credits, referrer_available_at AS available_at FROM referral_rewards r
     WHERE referrer_id = ? AND cancelled_at = 0 AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE ref = ? || r.friend_id)
     ORDER BY referrer_available_at`,
    [userId, REFERRER_PREFIX],
  );
  return {
    code: await referralCode(userId),
    joined: Number(row?.joined ?? 0),
    rewarded: Number(row?.rewarded ?? 0),
    earned: Math.max(0, Number(row?.earned ?? 0)),
    pending: pending.map((p) => ({ credits: Number(p.credits), availableAt: Number(p.available_at) })),
  };
}
