/*
 * Which browser asked for a sign-in or reset link. Anyone can ask for a link to their own inbox and
 * send it to someone else ("your Flash sign-in link"): opened in that person's browser, it would sign
 * them in to the sender's account, where what they then type, upload or connect is the sender's to
 * read. So a link works at once only in the browser that asked for it; anywhere else (another device,
 * or a link someone sent) the person types the address it was sent to first.
 */
import { timingSafeEqual } from "node:crypto";
import { emailKey } from "./account.ts";
import { isSecure, readCookie } from "./auth.ts";
import { sha256 } from "./ids.ts";

const COOKIE = "flash_link_for";
// As long as the longest link lasts (a reset link: an hour).
const MAX_AGE = 3600;

const keyOf = (email: string) => sha256(`link-for:${emailKey(email.trim().toLowerCase())}`);

/** The cookie that marks this browser as the one that asked for a link to this address. */
export const askedCookie = (email: string, request: Request) =>
  `${COOKIE}=${keyOf(email)}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${isSecure(request) ? "; Secure" : ""}`;

/**
 * Whether a link sent to this address may be used here: the browser asked for it, or the person
 * typed the address (any case, Gmail dots and +tags aside, as emailKey reads it).
 */
export function mayUse(linkEmail: string, request: Request, typed: unknown): "ok" | "ask" | "wrong" {
  const want = keyOf(linkEmail);
  const asked = readCookie(request, COOKIE);
  if (asked && asked.length === want.length && timingSafeEqual(Buffer.from(asked), Buffer.from(want))) return "ok";
  if (typeof typed !== "string" || !typed.trim()) return "ask";
  return keyOf(typed.slice(0, 254)) === want ? "ok" : "wrong";
}
