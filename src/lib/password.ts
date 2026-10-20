/*
 * Passwords people choose: a strong one Flash suggests, and a plain word for how strong a typed one
 * is. Used by Flash's own password boxes (PasswordInput.tsx), and written out again as PASSWORDS in
 * flashdb-shim.ts for the apps Flash builds, which run outside Flash's code; test/password.test.ts
 * checks both give the same answers.
 */
import { msg } from "./i18n.ts";

// Letters and digits that can't be mistaken for each other when read or typed (no l, I, O, 0 or 1).
export const SUGGEST_LETTERS = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A strong password, like "Kq7m-Xp2r-Vh9t-Lw4z": 16 random characters (about 92 bits) in groups of
 * four, with a small letter, a capital and a digit. Random from the browser's (or Node's) crypto,
 * each character equally likely.
 */
export function strongPassword(): string {
  const n = SUGGEST_LETTERS.length;
  const limit = 256 - (256 % n);
  for (;;) {
    let out = "";
    while (out.length < 16) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      for (const b of bytes) if (b < limit && out.length < 16) out += SUGGEST_LETTERS[b % n];
    }
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /\d/.test(out)) return out.match(/.{4}/g)!.join("-");
  }
}

export type Strength = "" | "weak" | "okay" | "strong";

/** What Flash says about a password's strength, and on the button that suggests one. */
export const STRENGTH_WORDS: Record<Exclude<Strength, "">, string> = {
  weak: msg("Weak password. Try 12 or more characters with letters, numbers and symbols."),
  okay: msg("Okay password"),
  strong: msg("Strong password"),
};
export const SUGGEST_WORDS = msg("Suggest a strong password");

// Passwords people pick first, which are tried first.
export const COMMON = /password|passw0rd|qwerty|azerty|123456|654321|abcdef|abc123|letmein|welcome|iloveyou|admin|111111|000000/;

/** How strong a password is: "" when empty, then weak, okay or strong. */
export function passwordStrength(password: string): Strength {
  const pw = String(password ?? "");
  if (!pw) return "";
  if (pw.length < 8 || COMMON.test(pw.toLowerCase()) || new Set(pw).size < 5) return "weak";
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((kind) => kind.test(pw)).length;
  if (pw.length >= 16 || (pw.length >= 12 && kinds >= 3)) return "strong";
  if (kinds >= 2 || pw.length >= 12) return "okay";
  return "weak";
}
