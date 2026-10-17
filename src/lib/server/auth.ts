import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { all, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { isVerified } from "./account.ts";
import type { Translate } from "../i18n.ts";
import { MAX_ACCOUNTS } from "../accounts.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "flash_session";
const SESSION_DAYS = 30;
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 3600;

export type User = {
  id: string;
  email: string;
  name: string;
  // What Flash calls the user, and their work (Settings > General); empty until they fill them in.
  nickname?: string;
  work?: string;
  // The language Flash answers in (see languages.ts); "" for the language the user writes in.
  language?: string;
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

/** A new session row for the user: its token (for the cookie) and when it ends. */
export async function newSession(userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomId(32);
  const at = now();
  // Old sessions go now and then, here: a browser may now sign in to several accounts.
  await run("DELETE FROM sessions WHERE expires_at < ?", [at]);
  const expiresAt = at + SESSION_MAX_AGE * 1000;
  await run("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [sha256(token), userId, expiresAt, at]);
  return { token, expiresAt };
}

/** The session cookie for a token, lasting maxAge seconds. */
export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** Creates a session and returns the Set-Cookie header value for it. */
export async function createSession(userId: string, secure: boolean): Promise<string> {
  return sessionCookie((await newSession(userId)).token, SESSION_MAX_AGE, secure);
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return null; // A mangled cookie is no cookie, not a server error.
    }
  }
  return null;
}

/**
 * The user a request acts for. Usually the browser's one session cookie, exactly as before. Once a
 * browser is signed in to several accounts (see the jar below), each tab names its own account in
 * the X-Flash-Account header, and the request acts as that account or as nobody; see resolveSession.
 */
export async function getUser(request: Request): Promise<User | null> {
  // Byte for byte the old way when nothing names an account and the browser has only one.
  if (!request.headers.has(ACCOUNT_HEADER) && asParam(request) === null && listValue(request) === null) {
    return userForSession(readCookie(request, SESSION_COOKIE));
  }
  return (await resolveSession(request))?.user ?? null;
}

/** The signed-in user for a session cookie's value, for pages that read cookies directly. */
export async function userForSession(token: string | null | undefined): Promise<User | null> {
  if (!token) return null;
  return one<User>(
    `SELECT u.id, u.email, u.name, u.nickname, u.work, u.language, u.preferences, u.created_at, u.last_free_grant, u.verified_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [sha256(token), now()],
  );
}

/*
 * Several accounts in one browser, like Google's account switcher. The browser keeps every
 * account's session token (at most 5, one per account) in a second HttpOnly cookie, written only
 * while it holds 2 or more. flash_session stays as it always was: the account bare links, new tabs
 * and server-rendered pages use (the default), the one last switched to or added.
 *
 * Each tab of Flash keeps the account it shows in its own sessionStorage and names it on every
 * request (X-Flash-Account). A request that names an account acts as that account if the browser
 * holds a live session for it, and otherwise as nobody: never silently as another account. Once a
 * browser holds 2 or more accounts, a request that changes anything must name one. So a tab still
 * showing one account can't log out, charge, publish or connect as another.
 */

export { MAX_ACCOUNTS };
export const ACCOUNT_HEADER = "x-flash-account";
// The __Host- prefix means no subdomain, and no cookie with a longer Path, can stand in for it.
export const ACCOUNTS_COOKIE = "__Host-flash_accounts";
// On plain http (development on a local network), where __Host- cookies can't be set.
export const ACCOUNTS_COOKIE_HTTP = "flash_accounts";
const ACCOUNTS_VERSION = "1.";
// A session token: randomId(32), 43 characters of base64url, so "." can separate them.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// What a tab may name: a user id (16 characters for real accounts).
export const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type JarEntry = { token: string; user: User; expiresAt: number };
/**
 * The accounts this browser is signed in to, in the order they were added. byDefault is the one
 * flash_session holds; listed is whether the browser keeps a list of 2 or more; stale is whether
 * the list cookie no longer says exactly what is live.
 */
export type Jar = { entries: JarEntry[]; byDefault: JarEntry | null; listed: boolean; stale: boolean };

/** The answer to signing in to a sixth account in one browser. */
export function tooManyAccounts(t: Translate): Response {
  return Response.json({ error: t("You're signed in to 5 accounts on this browser. Log out of one first."), code: "too_many_accounts" }, { status: 409 });
}

/** Signing in to another account when the browser already holds MAX_ACCOUNTS. */
export class TooManyAccounts extends Error {
  constructor() {
    super("too_many_accounts");
  }
}

/** The tokens in a list cookie: its version first, then up to 5 well-formed tokens. Anything else is no list. */
export function parseAccounts(value: string | null | undefined): string[] {
  if (!value || !value.startsWith(ACCOUNTS_VERSION)) return [];
  const tokens: string[] = [];
  for (const token of value.slice(ACCOUNTS_VERSION.length).split(".")) {
    if (TOKEN.test(token) && !tokens.includes(token)) tokens.push(token);
    if (tokens.length === MAX_ACCOUNTS) break;
  }
  return tokens;
}

const accountsName = (secure: boolean) => (secure ? ACCOUNTS_COOKIE : ACCOUNTS_COOKIE_HTTP);

/** The list cookie for these tokens, or the cookie that clears it when fewer than 2 are left. */
export function accountsCookie(tokens: string[], secure: boolean): string {
  const name = accountsName(secure);
  const flags = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const kept = tokens.filter((t) => TOKEN.test(t)).slice(0, MAX_ACCOUNTS);
  if (kept.length < 2) return `${name}=; ${flags}; Max-Age=0`;
  return `${name}=${ACCOUNTS_VERSION}${kept.join(".")}; ${flags}; Max-Age=${SESSION_MAX_AGE}`;
}

/** The list cookie's value on this request: on https only the __Host- one, so a plain cookie can't shadow it. */
const listValue = (request: Request) => readCookie(request, accountsName(isSecure(request)));

const tokensOf = (entries: JarEntry[]) => entries.map((e) => e.token);

/** What a list cookie should say for these entries ("" for no cookie). */
const listFor = (entries: JarEntry[]) => (entries.length >= 2 ? `${ACCOUNTS_VERSION}${tokensOf(entries).join(".")}` : "");

/** Seconds left in a session, for its cookie's Max-Age when it is set again. */
const secondsLeft = (entry: JarEntry) => Math.max(0, Math.floor((entry.expiresAt - now()) / 1000));

type JarRow = User & { token_hash: string; expires_at: number };

async function readJar(defaultToken: string | null, list: string | null): Promise<Jar> {
  const listed = parseAccounts(list);
  let tokens = [...listed];
  if (defaultToken && !tokens.includes(defaultToken)) {
    // The default always counts, even when that makes the list too long.
    tokens = [...tokens.slice(0, MAX_ACCOUNTS - 1), defaultToken];
  }
  if (!tokens.length) return { entries: [], byDefault: null, listed: listed.length >= 2, stale: Boolean(list) };
  const hashes = tokens.map((t) => sha256(t));
  // The join drops sessions of deleted accounts (Turso runs with foreign keys off).
  const rows = await all<JarRow>(
    `SELECT s.token_hash, s.expires_at, u.id, u.email, u.name, u.nickname, u.work, u.language, u.preferences,
            u.created_at, u.last_free_grant, u.verified_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash IN (${hashes.map(() => "?").join(", ")}) AND s.expires_at > ?`,
    [...hashes, now()],
  );
  const byHash = new Map(rows.map((r) => [r.token_hash, r]));
  // One entry per account, where it was first added; flash_session's token wins for its account.
  const chosen = new Map<string, JarEntry>();
  tokens.forEach((token, i) => {
    const row = byHash.get(hashes[i]);
    if (!row) return;
    if (chosen.has(row.id) && token !== defaultToken) return;
    const user: User = {
      id: row.id,
      email: row.email,
      name: row.name,
      nickname: row.nickname,
      work: row.work,
      language: row.language,
      preferences: row.preferences,
      created_at: row.created_at,
      last_free_grant: row.last_free_grant,
      verified_at: row.verified_at,
    };
    chosen.set(row.id, { token, user, expiresAt: Number(row.expires_at) });
  });
  const entries = [...chosen.values()];
  const byDefault = entries.find((e) => e.token === defaultToken) ?? null;
  return { entries, byDefault, listed: listed.length >= 2, stale: (list ?? "") !== listFor(entries) };
}

const jars = new WeakMap<Request, Promise<Jar>>();

/** This browser's accounts, read once per request (getUser and a route's own reads share it). */
export function jarSessions(request: Request): Promise<Jar> {
  let jar = jars.get(request);
  if (!jar) {
    jar = readJar(readCookie(request, SESSION_COOKIE), listValue(request));
    jars.set(request, jar);
  }
  return jar;
}

/** The jar read again, for writing: sessions may have ended earlier in this request. */
function freshJar(request: Request): Promise<Jar> {
  jars.delete(request);
  return jarSessions(request);
}

/**
 * The account a page shows from this browser's accounts (Connect to Flash): the one it names
 * (?account=, from "Use another account") when that one is signed in here, else the default, else
 * the first; null when none is.
 */
export function shownAccount(jar: Jar, wanted: string | null | undefined): JarEntry | null {
  return (wanted ? jar.entries.find((e) => e.user.id === wanted) : undefined) ?? jar.byDefault ?? jar.entries[0] ?? null;
}

/** The jar for a page that reads cookies itself (a Server Component), as cookies().get gives them. */
export function jarFromCookies(get: (name: string) => string | undefined, secure: boolean): Promise<Jar> {
  return readJar(get(SESSION_COOKIE) ?? null, get(accountsName(secure)) ?? null);
}

/*
 * The links people follow (a new tab, a download), which can't send a header: these GETs alone read
 * the tab's account from ?as=, and only in the form the links take (an earlier version's page, a
 * CSV file, Stripe's seller link), none of which changes anything in Flash. Each answers with
 * Cache-Control: no-store. The same routes' other reads (the inbox's, which marks messages read)
 * are the page's own, which names the account in its header.
 */
const AS_LINKS: { path: RegExp; link: (query: URLSearchParams) => boolean }[] = [
  { path: /^\/api\/sites\/[^/]+\/versions$/, link: (q) => Boolean(q.get("view")) },
  { path: /^\/api\/sites\/[^/]+\/(?:members|inbox)$/, link: (q) => q.get("format") === "csv" },
  { path: /^\/api\/sites\/[^/]+\/orders$/, link: () => true },
  { path: /^\/api\/payments\/link$/, link: () => true },
];

export function asParamAllowed(method: string, pathname: string, query: URLSearchParams = new URLSearchParams()): boolean {
  return (method === "GET" || method === "HEAD") && AS_LINKS.some((a) => a.path.test(pathname) && a.link(query));
}

/** The ?as= account on a request that may use it, else null (ignored). */
function asParam(request: Request): string | null {
  const url = new URL(request.url);
  return asParamAllowed(request.method, url.pathname, url.searchParams) ? url.searchParams.get("as") : null;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The session a request acts as. A tab's X-Flash-Account (or ?as= on the links above) gives that
 * account when the browser holds a live session for it, else nobody. With nothing named, a change
 * gets nobody once the browser holds 2 or more accounts; anything else gets the default, as before.
 */
export async function resolveSession(request: Request): Promise<JarEntry | null> {
  const jar = await jarSessions(request);
  const named = request.headers.get(ACCOUNT_HEADER) ?? asParam(request);
  if (named !== null) return ACCOUNT_ID.test(named) ? (jar.entries.find((e) => e.user.id === named) ?? null) : null;
  if (!READS.has(request.method.toUpperCase()) && jar.listed) return null;
  return jar.byDefault;
}

/** Every session token this browser holds, live or not: its default and its list (Log out of all accounts). */
export function heldTokens(request: Request): string[] {
  const tokens = new Set(parseAccounts(listValue(request)));
  const def = readCookie(request, SESSION_COOKIE);
  if (def) tokens.add(def);
  return [...tokens];
}

/** Whether this browser may sign in to the account (already in the jar, or the jar has room). */
export async function canAdd(request: Request, userId: string | null): Promise<boolean> {
  const jar = await freshJar(request);
  return Boolean(userId && jar.entries.some((e) => e.user.id === userId)) || jar.entries.length < MAX_ACCOUNTS;
}

/** Whether this browser is signed in to any account. */
export async function signedInHere(request: Request): Promise<boolean> {
  return (await freshJar(request)).entries.length > 0;
}

/** The list cookie to send for these entries, when it changes (nothing for a browser that never had one). */
function listChange(request: Request, tokens: string[], secure: boolean): string[] {
  if (tokens.length < 2 && listValue(request) === null) return [];
  return [accountsCookie(tokens, secure)];
}

/**
 * Signs the browser in to an account as well as the ones it has: the account becomes the default.
 * One already in the jar keeps its session (no new row); a new one gets a session, unless the
 * browser already holds MAX_ACCOUNTS (TooManyAccounts, before anything is created). prior, the jar
 * as the request found it, keeps an account whose sessions ended just before (a reset) in its place.
 */
export async function addToJar(request: Request, userId: string, prior?: Jar): Promise<{ cookie: string; also: string[]; account: string; reused: boolean }> {
  const secure = isSecure(request);
  const jar = await freshJar(request);
  const existing = jar.entries.find((e) => e.user.id === userId);
  if (existing) {
    return { cookie: sessionCookie(existing.token, secondsLeft(existing), secure), also: jar.stale ? listChange(request, tokensOf(jar.entries), secure) : [], account: userId, reused: true };
  }
  if (jar.entries.length >= MAX_ACCOUNTS) throw new TooManyAccounts();
  const { token } = await newSession(userId);
  const live = tokensOf(jar.entries);
  let tokens = [...live, token];
  if (prior?.entries.some((e) => e.user.id === userId)) {
    const placed = prior.entries.map((e) => (e.user.id === userId ? token : e.token)).filter((t) => t === token || live.includes(t));
    tokens = [...placed, ...live.filter((t) => !placed.includes(t))];
  }
  return { cookie: sessionCookie(token, SESSION_MAX_AGE, secure), also: listChange(request, tokens, secure), account: userId, reused: false };
}

/**
 * The account a connector sign-in's callback acts as: the one that started it (owner, from its
 * flow) when the browser is signed in to it, whichever is the default. Otherwise the browser's
 * default as before, whose own flows alone it can take, so a flow that isn't theirs ends as
 * expired and stays for its owner. as is what to add to the address the callback sends the tab
 * back to, so that tab shows the account it acted as (only once several are signed in).
 */
export async function flowAccount(request: Request, owner: string | null): Promise<{ user: User | null; as: string }> {
  const jar = await jarSessions(request);
  const entry = owner ? jar.entries.find((e) => e.user.id === owner) : undefined;
  if (!entry) return { user: await getUser(request), as: "" };
  return { user: entry.user, as: jar.listed ? `&as=${encodeURIComponent(entry.user.id)}` : "" };
}

/** Whether the browser holds a live session for the account. */
export async function inJar(request: Request, userId: string): Promise<boolean> {
  return (await freshJar(request)).entries.some((e) => e.user.id === userId);
}

/**
 * A new session for an account in the jar, in the same place (after a password change ended its
 * others). Reads the jar as the request found it, so call jarSessions before the old sessions end.
 */
export async function replaceInJar(request: Request, userId: string, token: string): Promise<string[]> {
  const secure = isSecure(request);
  const jar = await jarSessions(request);
  const cookies: string[] = [];
  if (!jar.byDefault || jar.byDefault.user.id === userId) cookies.push(sessionCookie(token, SESSION_MAX_AGE, secure));
  const tokens = jar.entries.some((e) => e.user.id === userId) ? jar.entries.map((e) => (e.user.id === userId ? token : e.token)) : [...tokensOf(jar.entries), token];
  return [...cookies, ...listChange(request, tokens, secure)];
}

/**
 * Takes accounts out of the jar (their sessions already ended). If the default went, the first
 * account left (the oldest added) becomes it; with none left, both cookies are cleared.
 */
export async function removeFromJar(request: Request, userIds: string[]): Promise<{ cookies: string[]; next: JarEntry | null }> {
  const secure = isSecure(request);
  const jar = await freshJar(request);
  const left = jar.entries.filter((e) => !userIds.includes(e.user.id));
  const kept = jar.byDefault && left.includes(jar.byDefault) ? jar.byDefault : null;
  const next = kept ?? left[0] ?? null;
  const cookies: string[] = [];
  if (!next) cookies.push(clearSessionCookie());
  else if (next !== kept) cookies.push(sessionCookie(next.token, secondsLeft(next), secure));
  cookies.push(...listChange(request, tokensOf(left), secure));
  return { cookies, next };
}

/** The cookies that make an entry the default and leave the list exactly as live (Switch, and the accounts list). */
export function defaultCookies(request: Request, jar: Jar, entry: JarEntry | null): string[] {
  const secure = isSecure(request);
  const cookies: string[] = [];
  if (entry && entry !== jar.byDefault) cookies.push(sessionCookie(entry.token, secondsLeft(entry), secure));
  if (!entry && readCookie(request, SESSION_COOKIE)) cookies.push(clearSessionCookie());
  if (jar.stale) cookies.push(...listChange(request, tokensOf(jar.entries), secure));
  return cookies;
}

export async function endSession(request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
}

export const isSecure = (request: Request) =>
  new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";

/**
 * Whether a request that signs someone in came from Flash's own pages. Without this another site
 * (or a published app, which runs in its own sealed-off origin) could post a form that signs the
 * visitor in to an account the other site controls, and then see what they make there.
 * Flash's pages always send JSON, which a plain form on another site can't, and browsers say which
 * site sent a request in the Origin header, which must be this one (as the configured address or
 * the host the request came to, like Next.js does for server actions). Apps and scripts that send
 * no Origin at all aren't browsers, so they can't be used against a visitor this way.
 */
export function fromOwnPage(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return ownOrigin(request, origin);
}

/**
 * Log out from a Flash page loaded before a browser could hold several accounts: it posts no body
 * and no type at all. Browsers name the sending site in Origin on every such request, so this one
 * must say it came from this site; another site's page, or one that hides where it is, can't.
 */
export function oldPageLogout(request: Request): boolean {
  if (request.headers.has("content-type") || request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  return origin !== null && ownOrigin(request, origin);
}

/** Whether an Origin header names this site. */
function ownOrigin(request: Request, origin: string): boolean {
  // A sealed-off page sends "null", which isn't an address, so it matches nothing.
  const hostOf = (address: string) => {
    try {
      return new URL(address).host;
    } catch {
      return null;
    }
  };
  const host = hostOf(origin);
  const own = [hostOf(appUrl(request)), hostOf(request.url), request.headers.get("x-forwarded-host"), request.headers.get("host")];
  return Boolean(host) && own.includes(host);
}

export function unauthorized(): Response {
  return Response.json({ error: "Please sign in.", code: "signed_out" }, { status: 401 });
}

/**
 * The owner and anyone else listed in FLASH_ADMIN_EMAILS (comma separated) can open /admin,
 * once they have confirmed the address (so nobody can sign up with it first and get in).
 */
export function isAdmin(user: Pick<User, "email" | "verified_at">): boolean {
  const admins = (process.env.FLASH_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(user.email.toLowerCase()) && isVerified(user);
}

/**
 * The site's address for links in emails and Stripe redirects: FLASH_APP_URL when set, so a
 * spoofed Host header can't point them elsewhere, else the address the request came to.
 */
export function appUrl(request: Request): string {
  const configured = process.env.FLASH_APP_URL?.trim().replace(/\/+$/, "");
  return configured || new URL(request.url).origin;
}
