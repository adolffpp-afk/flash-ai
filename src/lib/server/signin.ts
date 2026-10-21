/*
 * Signing in without a password: with Google, GitHub or Microsoft, or with an emailed link.
 * Accounts are matched by email (Gmail-style aliases count as the same inbox), but only when the
 * provider says it has confirmed that email.
 */
import { backfillEmailKeys, emailKey, endAllSessions, markVerified } from "./account.ts";
import { ensureMonthlyCredits } from "./credits.ts";
import { all, db, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import type { Profile } from "./oauth.ts";
import { verificationRequired } from "./email.ts";
import { createUser } from "./users.ts";

export const LINK_MINUTES = 15;

type Account = { id: string; email: string; email_key: string; password_hash: string; verified_at: number };

/** The account for this email or another alias of the same inbox, preferring an exact match. */
export async function findAccount(email: string): Promise<Account | null> {
  await backfillEmailKeys();
  const e = email.trim().toLowerCase();
  return one<Account>(
    `SELECT id, email, email_key, password_hash, verified_at FROM users
     WHERE email = ? OR email_key = ? ORDER BY (email = ?) DESC, created_at LIMIT 1`,
    [e, emailKey(e), e],
  );
}

/**
 * What was set up on an account before its owner proved the inbox is theirs, dropped: whoever
 * created it may not have been them. The password and sign-ins go (they can set a password again
 * with "Forgot password"), and so do the connected accounts (Settings > Connectors), with their
 * tools, what was always allowed and the cards still waiting, the sign-ins under way and any client
 * ID and secret typed in for a server: a server someone else added must never get the owner's tool
 * calls, and nobody else's client may sign the owner in. Two-step sign-in goes too, and so do
 * automations, their runs and notices.
 */
async function dropUnconfirmed(userId: string): Promise<void> {
  await run("UPDATE users SET password_hash = '' WHERE id = ?", [userId]);
  await run("DELETE FROM identities WHERE user_id = ?", [userId]);
  await endAllSessions(userId);
  // Each deleted by hand, in one batch (Turso runs with foreign keys off; see removeConnection).
  await (await db()).batch(
    [
      { sql: "DELETE FROM pending_actions WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM connection_tools WHERE connection_id IN (SELECT id FROM connections WHERE user_id = ?)", args: [userId] },
      { sql: "DELETE FROM connection_files WHERE connection_id IN (SELECT id FROM connections WHERE user_id = ?)", args: [userId] },
      { sql: "DELETE FROM connections WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM connect_flows WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM mcp_client_registrations WHERE owner_user_id = ?", args: [userId] },
      // Two-step sign-in a stranger turned on would lock the owner out with the stranger's app.
      { sql: "DELETE FROM two_factor WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM two_factor_recovery WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM two_factor_pending WHERE user_id = ?", args: [userId] },
      // Automations need a confirmed email, so there should be none; this is a safety net. Holds and
      // the ledger stay (they are the money record).
      { sql: "DELETE FROM automation_run_steps WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM automation_runs WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM automation_versions WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM automations WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM notifications WHERE user_id = ?", args: [userId] },
    ],
    "write",
  );
}

/** The person just proved they own the account's inbox. If the account was never confirmed, see dropUnconfirmed. */
async function claim(account: Account): Promise<void> {
  if (Number(account.verified_at) > 0) return;
  if (verificationRequired()) await dropUnconfirmed(account.id);
  await markVerified(account.id);
  await ensureMonthlyCredits(account.id);
}

/**
 * A new password from a reset link: opening it proved the inbox is theirs, so an account never
 * confirmed is claimed as with a sign-in link (see dropUnconfirmed), and every device is signed out.
 * here is the sign-in (its hash) of the browser doing it, which is signed in again and keeps its
 * alerts (see endAllSessions).
 */
export async function resetPassword(userId: string, passwordHash: string, here = ""): Promise<void> {
  const account = await one<{ verified_at: number }>("SELECT verified_at FROM users WHERE id = ?", [userId]);
  if (account && !Number(account.verified_at) && verificationRequired()) await dropUnconfirmed(userId);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
  await endAllSessions(userId, here);
  await markVerified(userId);
}

async function link(profile: Profile, userId: string): Promise<void> {
  await run("INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)", [
    profile.provider,
    profile.subject,
    userId,
    now(),
  ]);
}

/** The account an email signs in to (see findAccount), or null when a sign-in would make one. Creates nothing. */
export async function accountIdForEmail(email: string | null | undefined): Promise<string | null> {
  return email ? ((await findAccount(email))?.id ?? null) : null;
}

/**
 * The account someone back from Google, GitHub or Microsoft would sign in to, without signing them
 * in: the one their identity is linked to, else the one with the email the provider confirmed. Null
 * when signing in would make a new account (or can't). Creates nothing, so the browser's room for
 * another account can be checked before anything is created (see signInWithProvider).
 */
export async function providerAccountId(profile: Profile): Promise<string | null> {
  const linked = await one<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", [profile.provider, profile.subject]);
  if (linked) return linked.user_id;
  if (!profile.email || !profile.emailVerified) return null;
  return accountIdForEmail(profile.email);
}

export type SignInResult = { ok: true; userId: string; created: boolean } | { ok: false; code: "no_email" | "unverified" };

/** Finds, links or creates the account for someone back from Google, GitHub or Microsoft. */
export async function signInWithProvider(profile: Profile, request?: Request): Promise<SignInResult> {
  const linked = await one<{ user_id: string }>("SELECT user_id FROM identities WHERE provider = ? AND subject = ?", [
    profile.provider,
    profile.subject,
  ]);
  if (linked) {
    // A provider-confirmed email that matches the account confirms the account too.
    if (profile.emailVerified) {
      const account = await one<Account>(
        "SELECT id, email, email_key, password_hash, verified_at FROM users WHERE id = ?",
        [linked.user_id],
      );
      if (account && account.email_key === emailKey(profile.email) && !Number(account.verified_at)) {
        await markVerified(account.id);
        await ensureMonthlyCredits(account.id);
      }
    }
    return { ok: true, userId: linked.user_id, created: false };
  }
  if (!profile.email) return { ok: false, code: "no_email" };
  const account = await findAccount(profile.email);
  if (account) {
    // Never attach to an existing account on an email the provider hasn't confirmed.
    if (!profile.emailVerified) return { ok: false, code: "unverified" };
    await claim(account);
    await link(profile, account.id);
    return { ok: true, userId: account.id, created: false };
  }
  const userId = await createUser({
    email: profile.email,
    name: profile.name,
    passwordHash: "",
    verified: profile.emailVerified,
    request,
  });
  await link(profile, userId);
  return { ok: true, userId, created: true };
}

/** The providers an account can sign in with, for the message shown when it has no password. */
export async function linkedProviders(userId: string): Promise<string[]> {
  const rows = await all<{ provider: string }>("SELECT provider FROM identities WHERE user_id = ? ORDER BY created_at", [userId]);
  return rows.map((r) => r.provider);
}

/** A one-time sign-in link code for this email. Asking again replaces the older link. */
export async function createSignInLink(email: string, next: string): Promise<string> {
  const token = randomId(32);
  const e = email.trim().toLowerCase();
  await run("DELETE FROM sign_in_links WHERE email = ? OR expires_at < ?", [e, now()]);
  await run("INSERT INTO sign_in_links (token_hash, email, next, expires_at, created_at) VALUES (?, ?, ?, ?, ?)", [
    sha256(token),
    e,
    next,
    now() + LINK_MINUTES * 60_000,
    now(),
  ]);
  return token;
}

/** The address a sign-in link was sent to, without using it up, or null if wrong, used or expired. */
export async function signInLinkEmail(token: string): Promise<string | null> {
  if (!token) return null;
  const row = await one<{ email: string }>("SELECT email FROM sign_in_links WHERE token_hash = ? AND expires_at > ?", [sha256(token), now()]);
  return row?.email ?? null;
}

/** Uses a sign-in link. Returns its email and destination, or null if wrong, used or expired. */
export async function redeemSignInLink(token: string): Promise<{ email: string; next: string } | null> {
  if (!token) return null;
  const row = await one<{ email: string; next: string }>(
    "SELECT email, next FROM sign_in_links WHERE token_hash = ? AND expires_at > ?",
    [sha256(token), now()],
  );
  if (!row) return null;
  const r = await run("DELETE FROM sign_in_links WHERE token_hash = ?", [sha256(token)]);
  return r.rowsAffected === 1 ? { email: row.email, next: row.next } : null;
}

/** Signs in whoever opened a sign-in link, creating the account on first use. */
export async function signInWithEmail(email: string, request?: Request): Promise<string> {
  const account = await findAccount(email);
  if (account) {
    await claim(account);
    return account.id;
  }
  return createUser({ email, passwordHash: "", verified: true, request });
}
