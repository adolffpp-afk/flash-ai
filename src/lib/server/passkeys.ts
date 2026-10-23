/*
 * Passkeys: signing in with the lock already on the person's phone or computer (Face ID, a
 * fingerprint, the device PIN, or a security key) instead of a password. Each passkey is a key
 * pair made on the device; Flash keeps only the public half, so there is nothing here that would
 * let anyone in if it leaked, and a passkey only ever works on Flash's own address, so a look-alike
 * site can't phish it.
 *
 * A passkey sign-in counts as both steps of two-step sign-in: it needs the device (something they
 * have) and the device's own lock (something they are or know), which browsers are asked to check
 * every time (userVerification "required"). So it skips the authenticator code page.
 *
 * The browser gets a random challenge to sign, kept here for CHALLENGE_MINUTES under the hash of a
 * cookie only that browser holds, so a challenge can't be used from another one, and each works once.
 * Verification itself is @simplewebauthn/server's.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { appUrl, isSecure, readCookie } from "./auth.ts";
import { all, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";

export const CHALLENGE_COOKIE = "flash_passkey";
const CHALLENGE_MINUTES = 5;
export const MAX_PASSKEYS = 10;

/**
 * Flash's address as passkeys see it: the host of FLASH_APP_URL (www.flash-app.dev), never the
 * bare domain, so a page on another subdomain can't ask for Flash's passkeys. FLASH_PASSKEY_RP_ID
 * overrides it, which only ever makes sense before anyone has added a passkey.
 */
export function relyingParty(request: Request): { id: string; origin: string } {
  const url = new URL(appUrl(request));
  return { id: process.env.FLASH_PASSKEY_RP_ID?.trim() || url.hostname, origin: url.origin };
}

// Password managers that name themselves by AAGUID, for the list in Settings. Anything else is "Passkey".
const MAKERS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

type Kind = "add" | "signin";

/** Keeps a new challenge for this browser; returns the cookie that names it. */
async function keepChallenge(request: Request, kind: Kind, challenge: string, userId = ""): Promise<string> {
  const token = randomId(32);
  await run("DELETE FROM passkey_challenges WHERE expires_at < ?", [now()]);
  await run("INSERT INTO passkey_challenges (token_hash, user_id, kind, challenge, expires_at) VALUES (?, ?, ?, ?, ?)", [
    sha256(token),
    userId,
    kind,
    challenge,
    now() + CHALLENGE_MINUTES * 60_000,
  ]);
  return `${CHALLENGE_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${CHALLENGE_MINUTES * 60}${isSecure(request) ? "; Secure" : ""}`;
}

/** Uses up this browser's challenge of this kind (and, for "add", this account's), or null. */
async function takeChallenge(request: Request, kind: Kind, userId = ""): Promise<string | null> {
  const token = readCookie(request, CHALLENGE_COOKIE);
  if (!token) return null;
  const row = await one<{ challenge: string }>(
    "SELECT challenge FROM passkey_challenges WHERE token_hash = ? AND kind = ? AND user_id = ? AND expires_at > ?",
    [sha256(token), kind, userId, now()],
  );
  if (!row) return null;
  // Deleted before it's checked, and only one request can delete it, so it works once.
  const used = await run("DELETE FROM passkey_challenges WHERE token_hash = ?", [sha256(token)]);
  return used.rowsAffected === 1 ? row.challenge : null;
}

export const clearChallengeCookie = () => `${CHALLENGE_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`;

type Row = { id: string; public_key: string; counter: number; transports: string; name: string; created_at: number; last_used_at: number };

const transportsOf = (row: Pick<Row, "transports">) =>
  (row.transports ? row.transports.split(",") : []) as AuthenticatorTransportFuture[];

export type Passkey = { id: string; name: string; createdAt: number; lastUsedAt: number };

/** The account's passkeys, newest first, for Settings. */
export async function listPasskeys(userId: string): Promise<Passkey[]> {
  const rows = await all<Row>("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at DESC", [userId]);
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: Number(r.created_at), lastUsedAt: Number(r.last_used_at) }));
}

/** What the browser needs to make a new passkey for this account, and the cookie for its challenge. */
export async function addOptions(user: { id: string; email: string; name?: string | null }, request: Request) {
  const rp = relyingParty(request);
  const existing = await all<Row>("SELECT id, transports FROM passkeys WHERE user_id = ?", [user.id]);
  const options = await generateRegistrationOptions({
    rpName: "Flash AI",
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name?.trim() || user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // The device it's already on isn't offered again.
    excludeCredentials: existing.map((r) => ({ id: r.id, transports: transportsOf(r) })),
    // Kept on the device (so signing in needs no email typed), and its lock asked for every time.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { options, cookie: await keepChallenge(request, "add", options.challenge, user.id) };
}

export type Added = { ok: true; passkey: Passkey } | { ok: false; reason: "expired" | "failed" | "full" };

/** Checks the browser's new passkey and keeps it on the account. */
export async function addPasskey(userId: string, request: Request, response: RegistrationResponseJSON): Promise<Added> {
  const challenge = await takeChallenge(request, "add", userId);
  if (!challenge) return { ok: false, reason: "expired" };
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", [userId]);
  if (Number(count?.n ?? 0) >= MAX_PASSKEYS) return { ok: false, reason: "full" };
  const rp = relyingParty(request);
  let info;
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
    });
    if (!result.verified) return { ok: false, reason: "failed" };
    info = result.registrationInfo;
  } catch {
    return { ok: false, reason: "failed" };
  }
  const { credential } = info;
  const name = MAKERS[info.aaguid] ?? "";
  const at = now();
  // A credential ID is the device's own, so one already on any account is refused, never moved.
  const r = await run(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING`,
    [credential.id, userId, Buffer.from(credential.publicKey).toString("base64url"), credential.counter, (credential.transports ?? []).join(","), name, at],
  );
  if (r.rowsAffected !== 1) return { ok: false, reason: "failed" };
  return { ok: true, passkey: { id: credential.id, name, createdAt: at, lastUsedAt: 0 } };
}

/** Takes a passkey off the account. The device keeps it, but it no longer opens Flash. */
export async function removePasskey(userId: string, id: string): Promise<boolean> {
  const r = await run("DELETE FROM passkeys WHERE user_id = ? AND id = ?", [userId, id]);
  return r.rowsAffected === 1;
}

/**
 * What the browser needs to sign in with a passkey. No account is named: the device offers the
 * passkeys it has for Flash, so nobody learns from this which emails have one.
 */
export async function signInOptions(request: Request) {
  const options = await generateAuthenticationOptions({ rpID: relyingParty(request).id, userVerification: "required" });
  return { options, cookie: await keepChallenge(request, "signin", options.challenge) };
}

export type Verified = { ok: true; userId: string } | { ok: false; reason: "expired" | "failed" };

/** Checks a passkey sign-in; on success, the account it opens. */
export async function verifyPasskeySignIn(request: Request, response: AuthenticationResponseJSON): Promise<Verified> {
  const challenge = await takeChallenge(request, "signin");
  if (!challenge) return { ok: false, reason: "expired" };
  const row = await one<Row & { user_id: string }>("SELECT * FROM passkeys WHERE id = ?", [String(response?.id ?? "")]);
  if (!row) return { ok: false, reason: "failed" };
  const rp = relyingParty(request);
  let newCounter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: { id: row.id, publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")), counter: Number(row.counter), transports: transportsOf(row) },
    });
    if (!result.verified) return { ok: false, reason: "failed" };
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    // A wrong signature, or a counter gone backwards (a copied security key), lands here.
    return { ok: false, reason: "failed" };
  }
  await run("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", [newCounter, now(), row.id]);
  return { ok: true, userId: row.user_id };
}
