/*
 * Two-step sign-in: once someone turns it on (Settings > Account), signing in with a password, an
 * email link, Google, GitHub or Microsoft, or a password reset doesn't sign them in yet. It gives a
 * short-lived "waiting for the code" cookie instead, and the session comes only after a code from
 * their authenticator app, or one of their recovery codes, at /signin/code. So a stolen password, or
 * someone else reading their email, isn't enough to get in.
 *
 * The app's secret is sealed like connector secrets (secret-box.ts), so two-step sign-in needs
 * CONNECTOR_KEYS. Recovery codes are kept only as hashes. Codes work once each.
 */
import { createSession, isSecure, leaveBrowser, readCookie } from "./auth.ts";
import { db, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { clearLimit, clientIp, overLimit } from "./limits.ts";
import { connectorsReady, seal, unseal } from "./secret-box.ts";
import { base32, checkCode, newSecret, otpauthUri } from "./totp.ts";
import { randomBytes } from "node:crypto";

export const PENDING_COOKIE = "flash_2fa";
const PENDING_MINUTES = 10;
// Wrong codes allowed for one waiting sign-in, and for one account in 15 minutes.
const PENDING_TRIES = 5;
const ACCOUNT_TRIES = 10;
const WINDOW = 15 * 60_000;
const RECOVERY_CODES = 10;

const place = (userId: string) => ({ id: userId, userId, provider: "flash", field: "totp" });

/** Whether two-step sign-in can be offered here (it needs CONNECTOR_KEYS to seal the secret). */
export const twoFactorReady = connectorsReady;

type Row = { enc_secret: string; enabled_at: number; last_step: number };

const rowOf = (userId: string) =>
  one<Row>("SELECT enc_secret, enabled_at, last_step FROM two_factor WHERE user_id = ?", [userId]);

export async function twoFactorOn(userId: string): Promise<boolean> {
  return Number((await rowOf(userId))?.enabled_at ?? 0) > 0;
}

/** How many unused recovery codes the account has left. */
export async function recoveryLeft(userId: string): Promise<number> {
  const r = await one<{ n: number }>("SELECT COUNT(*) AS n FROM two_factor_recovery WHERE user_id = ?", [userId]);
  return Number(r?.n ?? 0);
}

/** Starts turning it on: a new secret for the app to add (by QR code or typed), not on until confirmed. */
export async function startSetup(user: { id: string; email: string }): Promise<{ secret: string; uri: string } | null> {
  if (await twoFactorOn(user.id)) return null;
  const secret = newSecret();
  await run(
    `INSERT INTO two_factor (user_id, enc_secret, enabled_at, last_step, created_at) VALUES (?, ?, 0, -1, ?)
     ON CONFLICT(user_id) DO UPDATE SET enc_secret = excluded.enc_secret, last_step = -1, created_at = excluded.created_at
     WHERE two_factor.enabled_at = 0`,
    [user.id, seal(secret, place(user.id)).stored, now()],
  );
  return { secret, uri: otpauthUri(secret, user.email) };
}

/** Normalises a recovery code as typed ("ABCD-EFGH", "abcd efgh") for hashing. */
const recoveryKey = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, "");

async function makeRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const c = base32(randomBytes(5)).toLowerCase();
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  });
  await (await db()).batch(
    [
      { sql: "DELETE FROM two_factor_recovery WHERE user_id = ?", args: [userId] },
      ...codes.map((c) => ({ sql: "INSERT INTO two_factor_recovery (user_id, code_hash) VALUES (?, ?)", args: [userId, sha256(recoveryKey(c))] })),
    ],
    "write",
  );
  return codes;
}

/**
 * Whether a code from the app (or, when allowed, a recovery code) is right for this account, using
 * it up. An app code moves last_step forward in the same statement that checks it, so two requests
 * racing with one code can't both pass.
 */
async function spendCode(userId: string, typed: string, allowRecovery: boolean): Promise<boolean> {
  const row = await rowOf(userId);
  if (!row) return false;
  let secret: string;
  try {
    secret = unseal(row.enc_secret, place(userId));
  } catch {
    return false;
  }
  const step = checkCode(secret, typed, now(), Number(row.last_step));
  if (step !== null) {
    const r = await run("UPDATE two_factor SET last_step = ? WHERE user_id = ? AND last_step < ?", [step, userId, step]);
    return r.rowsAffected === 1;
  }
  if (!allowRecovery || !Number(row.enabled_at)) return false;
  const key = recoveryKey(typed);
  if (key.length !== 8) return false;
  const r = await run("DELETE FROM two_factor_recovery WHERE user_id = ? AND code_hash = ?", [userId, sha256(key)]);
  return r.rowsAffected === 1;
}

/** Counts a try against the account; true when it has had too many. */
const tooMany = (userId: string) => overLimit(`2fa:${userId}`, ACCOUNT_TRIES, WINDOW);

export type Checked = { ok: true } | { ok: false; reason: "wrong" | "busy" };

/** Turns it on with the first code from the app; returns the recovery codes to keep. */
export async function enableTwoFactor(userId: string, typed: string): Promise<{ ok: true; codes: string[] } | { ok: false; reason: "wrong" | "busy" }> {
  if (await tooMany(userId)) return { ok: false, reason: "busy" };
  const row = await rowOf(userId);
  if (!row || Number(row.enabled_at)) return { ok: false, reason: "wrong" };
  if (!(await spendCode(userId, typed, false))) return { ok: false, reason: "wrong" };
  await run("UPDATE two_factor SET enabled_at = ? WHERE user_id = ? AND enabled_at = 0", [now(), userId]);
  await clearLimit(`2fa:${userId}`);
  return { ok: true, codes: await makeRecoveryCodes(userId) };
}

/** Turns it off; needs a code from the app or a recovery code, so a borrowed session can't. */
export async function disableTwoFactor(userId: string, typed: string): Promise<Checked> {
  if (await tooMany(userId)) return { ok: false, reason: "busy" };
  if (!(await twoFactorOn(userId)) || !(await spendCode(userId, typed, true))) return { ok: false, reason: "wrong" };
  await (await db()).batch(
    [
      { sql: "DELETE FROM two_factor WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM two_factor_recovery WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM two_factor_pending WHERE user_id = ?", args: [userId] },
    ],
    "write",
  );
  await clearLimit(`2fa:${userId}`);
  return { ok: true };
}

/** New recovery codes (the old ones stop working); needs a code from the app. */
export async function renewRecoveryCodes(userId: string, typed: string): Promise<{ ok: true; codes: string[] } | { ok: false; reason: "wrong" | "busy" }> {
  if (await tooMany(userId)) return { ok: false, reason: "busy" };
  if (!(await twoFactorOn(userId)) || !(await spendCode(userId, typed, false))) return { ok: false, reason: "wrong" };
  return { ok: true, codes: await makeRecoveryCodes(userId) };
}

export const clearPendingCookie = () => `${PENDING_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * What to set once someone has proved who they are by a password, an email link, Google, GitHub or
 * Microsoft, or a reset link: the session cookie, or, with two-step sign-in on, the cookie that
 * waits for the code (twoFactor true; the page then goes to /signin/code). next is where to go after.
 */
export async function signInCookie(userId: string, request: Request, next = "/"): Promise<{ cookie: string; twoFactor: boolean }> {
  if (!(await twoFactorOn(userId))) return { cookie: await sessionHere(userId, request), twoFactor: false };
  const token = randomId(32);
  await run("DELETE FROM two_factor_pending WHERE expires_at < ?", [now()]);
  await run("INSERT INTO two_factor_pending (token_hash, user_id, next, attempts, expires_at) VALUES (?, ?, ?, 0, ?)", [
    sha256(token),
    userId,
    next,
    now() + PENDING_MINUTES * 60_000,
  ]);
  const cookie = `${PENDING_COOKIE}=${token}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${PENDING_MINUTES * 60}${isSecure(request) ? "; Secure" : ""}`;
  return { cookie, twoFactor: true };
}

export type Finished =
  | { ok: true; cookie: string; next: string }
  | { ok: false; reason: "expired" | "wrong" | "busy" };

/** The second step: a code for the sign-in waiting in this browser's cookie. */
export async function finishSignIn(request: Request, typed: string): Promise<Finished> {
  const token = readCookie(request, PENDING_COOKIE);
  if (!token) return { ok: false, reason: "expired" };
  if (await overLimit(`2fa-ip:${clientIp(request)}`, 30, WINDOW)) return { ok: false, reason: "busy" };
  // Counts the try first, in one statement, so parallel guesses can't get past the limit.
  const counted = await run(
    "UPDATE two_factor_pending SET attempts = attempts + 1 WHERE token_hash = ? AND expires_at > ? AND attempts < ?",
    [sha256(token), now(), PENDING_TRIES],
  );
  if (counted.rowsAffected !== 1) {
    await run("DELETE FROM two_factor_pending WHERE token_hash = ?", [sha256(token)]);
    return { ok: false, reason: "expired" };
  }
  const pending = await one<{ user_id: string; next: string }>("SELECT user_id, next FROM two_factor_pending WHERE token_hash = ?", [sha256(token)]);
  if (!pending) return { ok: false, reason: "expired" };
  if (await tooMany(pending.user_id)) return { ok: false, reason: "busy" };
  if (!(await spendCode(pending.user_id, typed, true))) return { ok: false, reason: "wrong" };
  const used = await run("DELETE FROM two_factor_pending WHERE token_hash = ?", [sha256(token)]);
  if (used.rowsAffected !== 1) return { ok: false, reason: "expired" };
  await clearLimit(`2fa:${pending.user_id}`);
  return { ok: true, cookie: await sessionHere(pending.user_id, request), next: pending.next || "/" };
}

/** A new session for this browser, in place of the one it holds (see leaveBrowser). */
async function sessionHere(userId: string, request: Request): Promise<string> {
  await leaveBrowser(request);
  return createSession(userId, isSecure(request));
}
