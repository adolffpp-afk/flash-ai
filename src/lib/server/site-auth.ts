/*
 * Accounts for the people who use a published app: they sign up and sign in on the app itself,
 * and each of them gets their own private data (flashDB.mine), separate from the shared records.
 *
 * Published apps run with no origin of their own, so they can't keep a cookie, read one, or send
 * one with a request. So signing in is a form that the browser posts like a normal page visit:
 * Flash sets the session cookie on that visit and sends the visitor back to the app. When the app
 * is served again, Flash reads the cookie and puts a short-lived key for this page into the page,
 * and the app's own requests carry that key. A stolen key is useless after two hours and nothing
 * else on Flash accepts it.
 */
import { one, run, all, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { hashPassword, verifyPassword } from "./auth.ts";
import { overLimit } from "./limits.ts";

export const SITE_COOKIE = "flash_app_session";
const SESSION_DAYS = 30;
// How long the key put into one page stays good. Long enough for a visit, short enough to be dull.
const PAGE_TOKEN_MINUTES = 120;
const MINUTE = 60_000;
export const MIN_PASSWORD = 8;
export const MAX_SITE_USERS = 5000;

export type SiteVisitor = { id: string; email: string; name: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The people signed up to an app, newest first, for its owner. */
export async function listSiteUsers(slug: string, limit = 500): Promise<(SiteVisitor & { createdAt: number })[]> {
  const rows = await all<{ id: string; email: string; name: string; created_at: number }>(
    "SELECT id, email, name, created_at FROM site_users WHERE site_slug = ? ORDER BY created_at DESC LIMIT ?",
    [slug, limit],
  );
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, createdAt: Number(r.created_at) }));
}

export async function countSiteUsers(slug: string): Promise<number> {
  return Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_users WHERE site_slug = ?", [slug]))?.n ?? 0);
}

/** The session cookie for a site, scoped so only that site's pages ever send it. */
export function sessionCookie(token: string, path: string, secure: boolean, days = SESSION_DAYS): string {
  const maxAge = days * 24 * 3600;
  return `${SITE_COOKIE}=${token}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(path: string): string {
  return `${SITE_COOKIE}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function startSession(userId: string, slug: string): Promise<string> {
  const token = randomId(32);
  await run("INSERT INTO site_sessions (token_hash, site_user_id, site_slug, expires_at) VALUES (?, ?, ?, ?)", [
    sha256(token),
    userId,
    slug,
    now() + SESSION_DAYS * 24 * 3600 * 1000,
  ]);
  return token;
}

/** Who a session cookie belongs to on this site, or null. */
export async function visitorForSession(slug: string, token: string | null | undefined): Promise<SiteVisitor | null> {
  if (!token) return null;
  return one<SiteVisitor>(
    `SELECT u.id, u.email, u.name FROM site_sessions s JOIN site_users u ON u.id = s.site_user_id
     WHERE s.token_hash = ? AND s.site_slug = ? AND s.expires_at > ?`,
    [sha256(token), slug, now()],
  );
}

/** A key for one page load, which the app's own requests carry, made from the visitor's sign-in. */
export async function newPageToken(visitorId: string, slug: string, sessionToken: string): Promise<string> {
  const token = randomId(24);
  await run("DELETE FROM site_page_tokens WHERE expires_at < ?", [now()]);
  await run("INSERT INTO site_page_tokens (token_hash, site_user_id, site_slug, expires_at, session_hash) VALUES (?, ?, ?, ?, ?)", [
    sha256(token),
    visitorId,
    slug,
    now() + PAGE_TOKEN_MINUTES * MINUTE,
    sha256(sessionToken),
  ]);
  return token;
}

/** The visitor a page key stands for, for the private data API, while the sign-in it came from lasts. */
export async function visitorForPageToken(slug: string, header: string | null): Promise<SiteVisitor | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  return one<SiteVisitor>(
    `SELECT u.id, u.email, u.name FROM site_page_tokens t JOIN site_users u ON u.id = t.site_user_id
     WHERE t.token_hash = ? AND t.site_slug = ? AND t.expires_at > ?
       AND (t.session_hash = '' OR EXISTS (SELECT 1 FROM site_sessions s WHERE s.token_hash = t.session_hash AND s.expires_at > ?))`,
    [sha256(token), slug, now(), now()],
  );
}

/**
 * Ends a sign-in. On an app's page on Flash the sign-in cookie only goes to the app's own pages,
 * not to this address, so the page sends its key and the sign-in is found from that.
 */
async function endSession(slug: string, cookieToken: string | null, pageToken: string): Promise<void> {
  const hashes = new Set<string>();
  if (cookieToken) hashes.add(sha256(cookieToken));
  if (pageToken) {
    const page = await one<{ session_hash: string }>(
      "SELECT session_hash FROM site_page_tokens WHERE token_hash = ? AND site_slug = ?",
      [sha256(pageToken), slug],
    );
    if (page?.session_hash) hashes.add(page.session_hash);
  }
  for (const hash of hashes) {
    await run("DELETE FROM site_sessions WHERE token_hash = ? AND site_slug = ?", [hash, slug]);
    await run("DELETE FROM site_page_tokens WHERE session_hash = ? AND site_slug = ?", [hash, slug]);
  }
  if (pageToken) await run("DELETE FROM site_page_tokens WHERE token_hash = ? AND site_slug = ?", [sha256(pageToken), slug]);
}

export type AuthAction = "signup" | "signin" | "signout";
/** What the app shows the visitor afterwards: ok, or a short reason the sign-in didn't work. */
export type AuthOutcome = { result: string; cookie?: string };

const outcome = (result: string): AuthOutcome => ({ result });

/**
 * Signs a visitor up, in or out of a published app. `path` is the cookie's path, so a session
 * belongs to this app alone.
 */
export async function siteAuth(
  slug: string,
  action: string,
  // page is the key of the page the visitor signs out from.
  form: { email?: string; password?: string; name?: string; page?: string },
  ip: string,
  path: string,
  secure: boolean,
  cookieToken: string | null,
): Promise<AuthOutcome> {
  if (!(await one("SELECT 1 FROM sites WHERE slug = ?", [slug]))) return outcome("no-app");
  if (action === "signout") {
    await endSession(slug, cookieToken, form.page ?? "");
    return { result: "signed-out", cookie: clearSessionCookie(path) };
  }
  if (action !== "signup" && action !== "signin") return outcome("unknown");
  const email = (form.email ?? "").trim().toLowerCase();
  const password = form.password ?? "";
  const name = (form.name ?? "").trim().slice(0, 80);
  if (!EMAIL.test(email) || email.length > 160) return outcome("bad-email");
  if (password.length < MIN_PASSWORD) return outcome("short-password");
  if (password.length > 200) return outcome("long-password");
  // Guessing passwords, and signing people up in bulk, are both slowed down per app and per visitor.
  if (await overLimit(`site-auth:${slug}:${ip}`, 12, 15 * MINUTE)) return outcome("too-many");
  if (await overLimit(`site-auth:${slug}`, 300, 15 * MINUTE)) return outcome("too-many");

  const existing = await one<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM site_users WHERE site_slug = ? AND email = ?",
    [slug, email],
  );
  if (action === "signup") {
    // An account that already exists signs in instead, so nobody is told whether an email is known.
    if (existing) {
      if (!(await verifyPassword(password, existing.password_hash))) return outcome("taken");
      return { result: "ok", cookie: sessionCookie(await startSession(existing.id, slug), path, secure) };
    }
    if ((await countSiteUsers(slug)) >= MAX_SITE_USERS) return outcome("full");
    const id = randomId(12);
    await run("INSERT INTO site_users (id, site_slug, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      slug,
      email,
      name,
      await hashPassword(password),
      now(),
    ]);
    return { result: "ok", cookie: sessionCookie(await startSession(id, slug), path, secure) };
  }
  if (!existing || !(await verifyPassword(password, existing.password_hash))) return outcome("wrong");
  return { result: "ok", cookie: sessionCookie(await startSession(existing.id, slug), path, secure) };
}

/** The owner removes someone from their app: their sign-in and their private records go with them. */
export async function removeSiteUser(slug: string, id: string): Promise<boolean> {
  const r = await run("DELETE FROM site_users WHERE site_slug = ? AND id = ?", [slug, id]);
  if (!r.rowsAffected) return false;
  await run("DELETE FROM site_sessions WHERE site_slug = ? AND site_user_id = ?", [slug, id]);
  await run("DELETE FROM site_page_tokens WHERE site_slug = ? AND site_user_id = ?", [slug, id]);
  await run("DELETE FROM site_records WHERE site_slug = ? AND owner = ?", [slug, id]);
  return true;
}
