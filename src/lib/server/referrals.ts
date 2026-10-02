import { referralBonus } from "../credits.ts";
import { balance, type Purchase } from "./credits.ts";
import { db, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";

/*
 * Referral links. A visitor who arrives on /?ref=<code> keeps the code in a cookie, and sign-up
 * records who referred them (once, never the same inbox). Nobody earns anything until the
 * friend's first real payment, so fake accounts are worth nothing. The rule and its numbers
 * live in credits.ts (referralBonus), where the pricing tests check them.
 */
export const REF_COOKIE = "flash_ref";
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
const REFERRER_REF = (friendId: string) => `referral:referrer:${friendId}`;

/**
 * Gives both referral bonuses if this purchase is the referred user's first real (Stripe)
 * payment. Safe to run twice: one reward per friend, and every ledger entry has a unique ref.
 * Returns whether bonuses were given.
 */
export async function rewardReferral(purchaseRef: string): Promise<boolean> {
  const p = await one<{ user_id: string; credits: number; test: number; referred_by: string | null; first: number }>(
    `SELECT p.user_id, p.credits, p.test, u.referred_by,
       NOT EXISTS (SELECT 1 FROM purchases e WHERE e.user_id = p.user_id AND e.test = 0 AND e.id < p.id) AS first
     FROM purchases p JOIN users u ON u.id = p.user_id WHERE p.ref = ?`,
    [purchaseRef],
  );
  if (!p || Number(p.test) || !Number(p.first) || !p.referred_by || p.referred_by === p.user_id) return false;
  if (!(await one("SELECT 1 FROM users WHERE id = ?", [p.referred_by]))) return false;
  const bonus = referralBonus(Number(p.credits));
  const t = now();
  // The bonuses go in only alongside this purchase's reward, in one transaction, and their refs
  // are unique, so running again adds nothing.
  const forThisReward = "WHERE EXISTS (SELECT 1 FROM referral_rewards WHERE friend_id = ? AND purchase_ref = ?)";
  const [reward] = await (await db()).batch(
    [
      {
        sql: `INSERT OR IGNORE INTO referral_rewards (friend_id, referrer_id, purchase_ref, friend_credits, referrer_credits, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [p.user_id, p.referred_by, purchaseRef, bonus.friend, bonus.referrer, t],
      },
      {
        sql: `INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) SELECT ?, ?, ?, ?, ? ${forThisReward}`,
        args: [p.user_id, bonus.friend, "Referral bonus: extra credits on your first purchase", FRIEND_REF(p.user_id), t,
          p.user_id, purchaseRef],
      },
      {
        sql: `INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) SELECT ?, ?, ?, ?, ? ${forThisReward}`,
        args: [p.referred_by, bonus.referrer, "Referral bonus: a friend you invited made their first purchase",
          REFERRER_REF(p.user_id), t, p.user_id, purchaseRef],
      },
    ],
    "write",
  );
  return reward.rowsAffected === 1;
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
  const sides = [
    { side: "friend", userId: reward.friend_id, credits: Number(reward.friend_credits) },
    { side: "referrer", userId: reward.referrer_id, credits: Number(reward.referrer_credits) },
  ];
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
  const prefixes = ["referral:referrer:", "referral-back:referrer:"];
  const row = await one<{ joined: number; rewarded: number; earned: number }>(
    `SELECT (SELECT COUNT(*) FROM users WHERE referred_by = ?) AS joined,
            (SELECT COUNT(*) FROM referral_rewards WHERE referrer_id = ?) AS rewarded,
            (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?
               AND (substr(ref, 1, ?) = ? OR substr(ref, 1, ?) = ?)) AS earned`,
    [userId, userId, userId, prefixes[0].length, prefixes[0], prefixes[1].length, prefixes[1]],
  );
  return {
    code: await referralCode(userId),
    joined: Number(row?.joined ?? 0),
    rewarded: Number(row?.rewarded ?? 0),
    earned: Math.max(0, Number(row?.earned ?? 0)),
  };
}
