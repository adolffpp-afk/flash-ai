import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "flash_session";
const SESSION_DAYS = 30;

export type User = {
  id: string;
  email: string;
  name: string;
  preferences: string;
  created_at: number;
  last_free_grant: number;
  verified_at: number;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Creates a session and returns the Set-Cookie header value for it. */
export async function createSession(userId: string, secure: boolean): Promise<string> {
  const token = randomId(32);
  const maxAge = SESSION_DAYS * 24 * 3600;
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [
    sha256(token),
    userId,
    now() + maxAge * 1000,
  ]);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function getUser(request: Request): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return one<User>(
    `SELECT u.id, u.email, u.name, u.preferences, u.created_at, u.last_free_grant, u.verified_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [sha256(token), now()],
  );
}

export async function endSession(request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
}

export const isSecure = (request: Request) =>
  new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";

export function unauthorized(): Response {
  return Response.json({ error: "Please sign in.", code: "signed_out" }, { status: 401 });
}

/** The owner and anyone else listed in FLASH_ADMIN_EMAILS (comma separated) can open /admin. */
export function isAdmin(user: User): boolean {
  const admins = (process.env.FLASH_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(user.email.toLowerCase());
}
