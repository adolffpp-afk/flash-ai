import { emailKey } from "./account.ts";
import { readCookie } from "./auth.ts";
import { ensureMonthlyCredits } from "./credits.ts";
import { run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { REF_COOKIE, referrerFor } from "./referrals.ts";

export type NewUser = {
  email: string;
  name?: string;
  // "" for accounts that sign in with Google, GitHub, Microsoft or an email link.
  passwordHash: string;
  // True when the email was already proven (a provider said so, or the person opened a link).
  verified?: boolean;
  // The sign-up request, for anything read from it at sign-up (such as a referral cookie).
  request?: Request;
};

/**
 * Creates an account and gives it this month's free credits. Every way of signing up comes
 * through here, so anything that should happen to new accounts belongs in this function.
 */
export async function createUser(user: NewUser): Promise<string> {
  const id = randomId();
  const email = user.email.trim().toLowerCase();
  const key = emailKey(email);
  const t = now();
  // The referral link's code, kept in a cookie since the visitor landed. Never the same inbox.
  const referrer = user.request ? await referrerFor(readCookie(user.request, REF_COOKIE), key) : null;
  await run(
    `INSERT INTO users (id, email, email_key, name, password_hash, created_at, verified_at, referred_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, key, user.name?.trim().slice(0, 80) || email.split("@")[0], user.passwordHash, t, user.verified ? t : 0, referrer],
  );
  await ensureMonthlyCredits(id);
  return id;
}
