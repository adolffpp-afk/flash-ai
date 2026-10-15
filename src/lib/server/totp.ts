import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Codes from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …):
 * RFC 6238 time-based one-time passwords, 6 digits from HMAC-SHA1 every 30 seconds, the standard
 * every app reads from an otpauth:// link or its QR code.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

/** A new random secret, in the base32 the apps take (20 bytes, as RFC 4226 recommends). */
export function newSecret(): string {
  return base32(randomBytes(20));
}

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not base32.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The time step a moment (in ms) falls in. */
export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The 6-digit code for one time step. */
export function codeFor(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

/**
 * The time step a typed code is for, or null if it's wrong. The step before and after count too,
 * for a phone clock a little off or a code typed as it changed. A step at or before `usedUpTo` is
 * refused, so a code someone saw can't be used again.
 */
export function checkCode(secret: string, typed: string, ms: number, usedUpTo = -1): number | null {
  const code = typed.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(ms);
  let found: number | null = null;
  // Every step is compared (in constant time), so how long this takes says nothing about the code.
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(codeFor(secret, step)), Buffer.from(code)) && step > usedUpTo && found === null) found = step;
  }
  return found;
}

/** The link an authenticator app reads (from its QR code) to add the account. */
export function otpauthUri(secret: string, account: string, issuer = "Flash AI"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
