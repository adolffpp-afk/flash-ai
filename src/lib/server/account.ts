import { all, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { EMAILS, demoEmails, sendEmail, verificationRequired } from "./email.ts";

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
  await sendEmail(user.email, EMAILS.verify(link), "account");
  return demoEmails() ? link : undefined;
}

export async function sendReset(user: { id: string; email: string }, origin: string): Promise<string | undefined> {
  const link = `${origin}/reset?token=${await createToken(user.id, "reset")}`;
  await sendEmail(user.email, EMAILS.reset(link), "account");
  return demoEmails() ? link : undefined;
}

export async function markVerified(userId: string): Promise<void> {
  await run("UPDATE users SET verified_at = ? WHERE id = ? AND verified_at = 0", [now(), userId]);
}

/** Signs a user out everywhere (after a password reset). */
export async function endAllSessions(userId: string): Promise<void> {
  await run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

/** Accounts created before email keys existed get theirs filled in. */
export async function backfillEmailKeys(): Promise<void> {
  const rows = await all<{ id: string; email: string }>("SELECT id, email FROM users WHERE email_key = '' LIMIT 500");
  for (const r of rows) await run("UPDATE users SET email_key = ? WHERE id = ?", [emailKey(r.email), r.id]);
}
