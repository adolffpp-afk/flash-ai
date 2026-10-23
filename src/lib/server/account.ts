import { all, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { EMAILS, demoEmails, sendEmail, verificationRequired } from "./email.ts";
import { clearScreens, screensOf } from "./push.ts";
import { afterResponse } from "./after-response.ts";

const HOUR = 3600 * 1000;
export type TokenKind = "verify" | "reset";
const TTL: Record<TokenKind, number> = { verify: 7 * 24 * HOUR, reset: HOUR };

/**
 * The address with +tags removed, and for Gmail the dots too, so the same inbox can't open
 * several accounts to collect free credits again.
 */
export function emailKey(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  let name = local.split("+")[0];
  let host = domain;
  if (host === "googlemail.com") host = "gmail.com";
  if (host === "gmail.com") name = name.replaceAll(".", "");
  return `${name}@${host}`;
}

export const isVerified = (user: { verified_at?: number | null }) =>
  !verificationRequired() || Number(user.verified_at ?? 0) > 0;

async function createToken(userId: string, kind: TokenKind): Promise<string> {
  const token = randomId(32);
  await run("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?", [userId, kind]);
  await run("INSERT INTO email_tokens (token_hash, user_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)", [
    sha256(token),
    userId,
    kind,
    now() + TTL[kind],
    now(),
  ]);
  return token;
}

/** The address of the account a reset link is for, without using it up, or null if wrong, used or expired. */
export async function resetLinkEmail(token: string): Promise<string | null> {
  const userId = await tokenOwner(token, "reset");
  return userId ? ((await one<{ email: string }>("SELECT email FROM users WHERE id = ?", [userId]))?.email ?? null) : null;
}

/** The account a reset link is for, without using it up, or null if wrong, used or expired. */
export const resetLinkUser = (token: string) => tokenOwner(token, "reset");

/** Whose one-time link this is, without using it up, or null if it is wrong, used or expired. */
async function tokenOwner(token: string, kind: TokenKind): Promise<string | null> {
  if (!token) return null;
  const row = await one<{ user_id: string }>(
    "SELECT user_id FROM email_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?",
    [sha256(token), kind, now()],
  );
  return row?.user_id ?? null;
}

/** Uses a one-time link. Returns the user it belongs to, or null if it is wrong, used or expired. */
export async function redeemToken(token: string, kind: TokenKind): Promise<string | null> {
  if (!token) return null;
  const row = await one<{ user_id: string }>(
    "SELECT user_id FROM email_tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?",
    [sha256(token), kind, now()],
  );
  if (!row) return null;
  const r = await run("DELETE FROM email_tokens WHERE token_hash = ?", [sha256(token)]);
  return r.rowsAffected === 1 ? row.user_id : null;
}

/** Emails a verification link. In demo mode the link is returned so it can be shown on screen. */
export async function sendVerification(user: { id: string; email: string }, origin: string): Promise<string | undefined> {
  if (!verificationRequired()) return undefined;
  const link = `${origin}/api/auth/verify?token=${await createToken(user.id, "verify")}`;
  // To an address not confirmed yet, so it uses the daily share for new addresses (see email.ts).
  if (!(await sendEmail(user.email, EMAILS.verify(link), "new"))) throw new Error("Today's emails to new addresses are used up.");
  return demoEmails() ? link : undefined;
}

export async function sendReset(user: { id: string; email: string }, origin: string): Promise<string | undefined> {
  const link = `${origin}/reset?token=${await createToken(user.id, "reset")}`;
  await sendEmail(user.email, EMAILS.reset(link), "account");
  return demoEmails() ? link : undefined;
}

/**
 * Uses a confirmation link for whoever is signed in (signedIn, a user id) in the browser that
 * opened it. Only someone signed in to that account can confirm it: anyone can sign up with another
 * person's email, and if that person then opened the link, the stranger's password would stay on an
 * account they now think is theirs. Otherwise the link is kept and they're asked to sign in first;
 * signing in with an email link or Google instead clears what the stranger set up (see signin.ts).
 */
export async function confirmEmail(token: string, signedIn: string | null): Promise<"confirmed" | "sign_in" | "invalid"> {
  return (await confirmEmailFor(token, signedIn ? [signedIn] : [])).status;
}

/**
 * confirmEmail for a browser signed in to several accounts (signedIn, their ids): the link confirms
 * its own account when that is one of them, and says which (userId) so the page can show it.
 */
export async function confirmEmailFor(token: string, signedIn: readonly string[]): Promise<{ status: "confirmed" | "sign_in" | "invalid"; userId: string | null }> {
  const owner = await tokenOwner(token, "verify");
  if (!owner) return { status: "invalid", userId: null };
  if (!signedIn.includes(owner)) return { status: "sign_in", userId: null };
  const userId = await redeemToken(token, "verify");
  if (!userId) return { status: "invalid", userId: null };
  await markVerified(userId);
  return { status: "confirmed", userId };
}

export async function markVerified(userId: string): Promise<void> {
  await run("UPDATE users SET verified_at = ? WHERE id = ? AND verified_at = 0", [now(), userId]);
}

/**
 * Signs a user out everywhere (after a password reset or change, or "Sign out everywhere"),
 * including apps like Claude connected to Flash: their tokens could have been given out by
 * whoever was signed in before, and would otherwise keep working for 30 days at a time. Alerts
 * stop in every browser too (see push.ts), so none reach a browser someone else was signed in on,
 * and the ones still on those browsers' screens go, and so do the account's passkeys. here is the
 * sign-in (its hash) of the browser doing it, which takes care of its own screen.
 */
export async function endAllSessions(userId: string, here = ""): Promise<void> {
  const screens = await screensOf(userId, here);
  await run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  await run("DELETE FROM oauth_tokens WHERE user_id = ?", [userId]);
  await run("DELETE FROM oauth_codes WHERE user_id = ?", [userId]);
  await run("DELETE FROM push_subscriptions WHERE user_id = ?", [userId]);
  // A passkey counts as both sign-in steps, so one planted with a stolen session would outlive
  // the sign-out: passkeys go too, and the owner adds theirs again (see passkeys.ts).
  await run("DELETE FROM passkeys WHERE user_id = ?", [userId]);
  // A push service can take up to 10 seconds to take each push (see push.ts), so the ones that clear
  // those screens go once the response has, and signing out never waits for them.
  if (screens.length) await afterResponse(() => clearScreens(userId, screens));
}

/** Accounts created before email keys existed get theirs filled in. */
export async function backfillEmailKeys(): Promise<void> {
  const rows = await all<{ id: string; email: string }>("SELECT id, email FROM users WHERE email_key = '' LIMIT 500");
  for (const r of rows) await run("UPDATE users SET email_key = ? WHERE id = ?", [emailKey(r.email), r.id]);
}
