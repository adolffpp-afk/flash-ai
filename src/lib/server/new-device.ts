/*
 * New-device sign-in emails: when an account signs in on a browser it has never used before, its
 * owner gets an email saying how and from which country, with what to do if it wasn't them. A
 * browser is known by a random cookie (DEVICE_COOKIE), kept here only as a hash per account; nothing
 * else about the browser is kept. An account's first browser after this began is noted quietly, so
 * nobody gets an email for the browser they already use.
 */
import { appUrl, isSecure, readCookie } from "./auth.ts";
import { one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { countryOf } from "./free.ts";
import { EMAILS, sendEmail } from "./email.ts";
import { overLimit } from "./limits.ts";
import { afterResponse } from "./after-response.ts";
import type { SignInMethod } from "./sign-ins.ts";

export const DEVICE_COOKIE = "flash_device";
// About 400 days, the longest browsers keep a cookie.
const DEVICE_DAYS = 400;
// At most this many of these emails an hour for one account, so a sign-in loop can't flood the inbox.
const EMAILS_PER_HOUR = 3;

const deviceCookie = (id: string, request: Request) =>
  `${DEVICE_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_DAYS * 86400}${isSecure(request) ? "; Secure" : ""}`;

/**
 * Notes that this account just signed in on this browser, and emails its owner when it's one the
 * account hasn't used before (and not its first). Returns the cookie that names the browser, for
 * the sign-in's response. Never fails the sign-in.
 */
export async function noteDevice(userId: string, request: Request, method: SignInMethod): Promise<string[]> {
  try {
    const held = readCookie(request, DEVICE_COOKIE);
    const id = held && /^[A-Za-z0-9_-]{16,64}$/.test(held) ? held : randomId(24);
    const at = now();
    const known = await run("UPDATE known_devices SET last_at = ? WHERE user_id = ? AND device_hash = ?", [at, userId, sha256(id)]);
    if (known.rowsAffected === 0) {
      const before = await one<{ n: number }>("SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?", [userId]);
      await run("INSERT OR IGNORE INTO known_devices (user_id, device_hash, first_at, last_at) VALUES (?, ?, ?, ?)", [userId, sha256(id), at, at]);
      if (Number(before?.n ?? 0) > 0 && method !== "sign_up") await alert(userId, request, method);
    }
    return [deviceCookie(id, request)];
  } catch (err) {
    console.error("[flash] new-device check failed", err);
    return [];
  }
}

async function alert(userId: string, request: Request, method: SignInMethod): Promise<void> {
  if (await overLimit(`new-device:${userId}`, EMAILS_PER_HOUR, 60 * 60_000)) return;
  const user = await one<{ email: string }>("SELECT email FROM users WHERE id = ?", [userId]);
  if (!user) return;
  const country = countryOf(request);
  const message = EMAILS.newDevice({
    method,
    country: /^[A-Z]{2}$/.test(country) ? country : "",
    at: now(),
    link: appUrl(request),
  });
  await afterResponse(() => sendEmail(user.email, message, "account").catch((err) => console.error("[flash] new-device email failed", err)));
}
