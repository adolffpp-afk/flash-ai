import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { register } from "node:module";

/*
 * Several Flash accounts in one browser (see auth.ts): the cookies, which account each request acts
 * as, adding and removing accounts, switching, and the links and flows that belong to one account.
 * Everything runs through Flash's own route handlers on an in-memory database, with no real service.
 */
register("./support/route-hooks.mjs", import.meta.url);

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_DEMO_EMAILS = "true";
delete process.env.RESEND_API_KEY;
delete process.env.FLASH_APP_URL;
delete process.env.VERCEL_ENV;
// Two-step sign-in seals its secret with the connector keys.
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";
// Connecting GitHub and Google Drive is set up, though nothing here reaches either.
process.env.GITHUB_APP_CLIENT_ID = "gh-client";
process.env.GITHUB_APP_CLIENT_SECRET = "gh-secret";
process.env.GITHUB_APP_SLUG = "flash-test";
process.env.GOOGLE_CONNECT_CLIENT_ID = "gc-client";
process.env.GOOGLE_CONNECT_CLIENT_SECRET = "gc-secret";
process.env.GOOGLE_PICKER_API_KEY = "picker";
process.env.GOOGLE_CONNECT_PROJECT_NUMBER = "123456";

const auth = await import("../src/lib/server/auth.ts");
const { all, one, run } = await import("../src/lib/server/db.ts");
const { randomId, sha256 } = await import("../src/lib/server/ids.ts");
const meRoute = await import("../src/app/api/me/route.ts");
const projectRoute = await import("../src/app/api/projects/[id]/route.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");
const tf = await import("../src/lib/server/two-factor.ts");
const { codeFor, stepAt } = await import("../src/lib/server/totp.ts");
const oauth = await import("../src/lib/server/oauth.ts");
const loginRoute = await import("../src/app/api/auth/login/route.ts");
const signupRoute = await import("../src/app/api/auth/signup/route.ts");
const emailLinkRoute = await import("../src/app/api/auth/email-link/route.ts");
const resetRoute = await import("../src/app/api/auth/reset/route.ts");
const twoFactorRoute = await import("../src/app/api/auth/two-factor/route.ts");
const callbackRoute = await import("../src/app/api/auth/oauth/[provider]/callback/route.ts");
const passwordRoute = await import("../src/app/api/me/password/route.ts");
const switchRoute = await import("../src/app/api/auth/switch/route.ts");
const accountsRoute = await import("../src/app/api/auth/accounts/route.ts");
const logoutRoute = await import("../src/app/api/auth/logout/route.ts");
const siteOwner = await import("../src/lib/server/site-owner.ts");
const consentRoute = await import("../src/app/api/oauth/authorize/route.ts");
const verifyRoute = await import("../src/app/api/auth/verify/route.ts");
const acceptRoute = await import("../src/app/api/team/accept/route.ts");
const mcpCallback = await import("../src/app/api/connect/mcp/callback/route.ts");
const githubCallback = await import("../src/app/api/connect/github/callback/route.ts");
const googleCallback = await import("../src/app/api/connect/google/callback/route.ts");
const fileRoute = await import("../src/app/api/files/[id]/route.ts");
const pageRoute = await import("../src/app/p/[slug]/route.ts");
const payLinkRoute = await import("../src/app/api/payments/link/route.ts");
const ownerRoute = await import("../src/app/api/sites/[slug]/owner/route.ts");
// Added on main after the plan: they read the account through getUser, so they follow the tab's account too.
const autoTopUpRoute = await import("../src/app/api/billing/auto-topup/route.ts");
const driveStartRoute = await import("../src/app/api/connect/google/start/route.ts");
const pickerTokenRoute = await import("../src/app/api/connect/google/picker-token/route.ts");
const driveFilesRoute = await import("../src/app/api/connect/google/files/route.ts");
const madeWithRoute = await import("../src/app/api/sites/[slug]/made-with/route.ts");
const adminReportsRoute = await import("../src/app/api/admin/reports/route.ts");
const { registerClient } = await import("../src/lib/server/connector.ts");
const { sendVerification } = await import("../src/lib/server/account.ts");
const { receiveMessage } = await import("../src/lib/server/inbox.ts");
const { afterwards } = await import("./support/next-server.mjs");
const { createSignInLink, providerAccountId } = await import("../src/lib/server/signin.ts");
const { referralCode } = await import("../src/lib/server/referrals.ts");

const ORIGIN = "https://flash-app.test";
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) }) as never;

let users = 0;
/** A confirmed account with a password ("secret123" unless given) and a chat. */
async function account(id: string, password = "secret123") {
  users++;
  await run(
    "INSERT INTO users (id, email, email_key, name, password_hash, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [id, `${id}@x.io`, `${id}@x.io`, `User ${id}`, await auth.hashPassword(password), users],
  );
  await run("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Notes', '[]', 0)", [`proj_${id}`, id]);
  return id;
}

/** A live session for the user, as a sign-in makes: its raw token. */
async function session(userId: string, ms = 30 * 86_400_000): Promise<string> {
  const token = randomId(32);
  await run("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [sha256(token), userId, Date.now() + ms, Date.now()]);
  return token;
}

/** The Cookie header of a browser: its default account, and its list of accounts (when it has one). */
function jarCookie({ def, list, http = false }: { def?: string; list?: string[]; http?: boolean }): string {
  const parts: string[] = [];
  if (def) parts.push(`flash_session=${def}`);
  if (list) parts.push(`${http ? "flash_accounts" : "__Host-flash_accounts"}=1.${list.join(".")}`);
  return parts.join("; ");
}

type Req = { method?: string; cookie?: string; account?: string; as?: string; json?: unknown; body?: BodyInit; origin?: string | null; site?: string; headers?: Record<string, string>; base?: string; ip?: string };
let ips = 0;
/** A request as Flash's page sends it: JSON from its own origin, naming the tab's account when given. */
function req(path: string, o: Req = {}): Request {
  // Each request from its own network unless given, so sign-in limits per network don't add up across tests.
  const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? `10.9.${Math.floor(++ips / 250)}.${ips % 250}`, ...o.headers };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.account !== undefined) headers["x-flash-account"] = o.account;
  if (o.json !== undefined) headers["content-type"] = "application/json";
  const origin = o.origin === undefined ? (o.base ?? ORIGIN) : o.origin;
  if (origin !== null) headers.origin = origin;
  if (o.site) headers["sec-fetch-site"] = o.site;
  const url = new URL(`${o.base ?? ORIGIN}${path}`);
  if (o.as !== undefined) url.searchParams.set("as", o.as);
  const method = o.method ?? (o.json !== undefined ? "POST" : "GET");
  return new Request(url, { method, headers, body: o.json !== undefined ? JSON.stringify(o.json) : o.body });
}

type SetCookie = { value: string; attrs: string; maxAge: number | null };
/** The cookies a response sets, by name (the last one set wins, as in a browser). */
function setCookies(res: Response): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";");
    const at = pair.indexOf("=");
    const age = attrs.map((a) => a.trim()).find((a) => a.startsWith("Max-Age="));
    out[pair.slice(0, at).trim()] = { value: pair.slice(at + 1), attrs: attrs.join(";"), maxAge: age ? Number(age.slice(8)) : null };
  }
  return out;
}
const listOf = (res: Response) => auth.parseAccounts(setCookies(res)["__Host-flash_accounts"]?.value);
const sessionHashes = async () => (await all<{ token_hash: string }>("SELECT token_hash FROM sessions ORDER BY token_hash")).map((r) => r.token_hash);
const userOf = async (token: string) => (await auth.userForSession(token))?.id ?? null;
const login = (email: string, cookie = "", password = "secret123") => loginRoute.POST(req("/api/auth/login", { cookie, json: { email, password } }));
/** A browser cookie after a response, as the browser would keep it. */
function after(cookie: string, res: Response): string {
  const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]));
  for (const [name, c] of Object.entries(setCookies(res))) {
    if (c.maxAge === 0) jar.delete(name);
    else jar.set(name, c.value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
/** Turns two-step sign-in on for an account; returns its secret. */
async function twoStep(userId: string): Promise<string> {
  const setup = (await tf.startSetup({ id: userId, email: `${userId}@x.io` }))!;
  assert.ok((await tf.enableTwoFactor(userId, codeFor(setup.secret, stepAt(Date.now()) - 1))).ok);
  return setup.secret;
}
/** A browser signed in to these accounts (the last one the default), as its cookie. */
async function browser(...ids: string[]): Promise<{ cookie: string; tokens: string[] }> {
  const tokens = [];
  for (const id of ids) tokens.push(await session(id));
  return { cookie: jarCookie({ def: tokens.at(-1), list: tokens.length > 1 ? tokens : undefined }), tokens };
}
const count = async (sql: string, args: (string | number)[] = []) => Number((await one<{ n: number }>(sql, args))!.n);
const ledger = async (id: string) => all("SELECT id, amount, reason, ref, settled_at FROM credit_ledger WHERE user_id = ? ORDER BY id", [id]);

// ---------------------------------------------------------------------------------------------
// The cookies

test("the list cookie's parser takes only its version and up to 5 well-formed, different tokens", () => {
  const t = Array.from({ length: 7 }, () => randomId(32));
  assert.deepEqual(auth.parseAccounts(`1.${t[0]}.${t[1]}`), [t[0], t[1]]);
  assert.deepEqual(auth.parseAccounts(`1.${t[0]}.bad!token.${t[1].slice(1)}.${t[1]}x.${t[2]}`), [t[0], t[2]], "bad characters and wrong lengths are dropped");
  assert.deepEqual(auth.parseAccounts(`1.${t[0]}.${t[0]}.${t[1]}`), [t[0], t[1]], "duplicates once");
  assert.deepEqual(auth.parseAccounts(`1.${t.join(".")}`), t.slice(0, 5), "at most 5");
  for (const bad of [null, undefined, "", t[0], `2.${t[0]}.${t[1]}`, `1${t[0]}`, `.${t[0]}`]) assert.deepEqual(auth.parseAccounts(bad), [], String(bad));
  for (let i = 0; i < 2000; i++) {
    const token = randomId(32);
    assert.ok(token.length === 43 && !token.includes("."), token);
  }
});

test("the list cookie is HttpOnly, __Host- on https, plain on http, and cleared below 2 accounts", () => {
  const [a, b] = [randomId(32), randomId(32)];
  const secure = auth.accountsCookie([a, b], true);
  assert.ok(secure.startsWith(`__Host-flash_accounts=1.${a}.${b};`), secure);
  for (const flag of ["Path=/", "HttpOnly", "SameSite=Lax", "Secure", "Max-Age=2592000"]) assert.ok(secure.includes(flag), flag);
  assert.doesNotMatch(secure, /Domain=/i);
  const plain = auth.accountsCookie([a, b], false);
  assert.ok(plain.startsWith(`flash_accounts=1.${a}.${b};`), plain);
  assert.doesNotMatch(plain, /Secure/);
  for (const one of [[a], []]) {
    const cleared = auth.accountsCookie(one, true);
    assert.match(cleared, /^__Host-flash_accounts=;/);
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /Secure/, "a __Host- cookie is only cleared with Secure");
  }
});

test("on https a plain flash_accounts cookie is ignored, and a mangled list falls back to flash_session", async () => {
  const a = await account("ca");
  const b = await account("cb");
  const [ta, tb] = [await session(a), await session(b)];
  const shadow = req("/api/me", { cookie: `flash_session=${ta}; ${jarCookie({ list: [ta, tb], http: true })}`, account: b });
  assert.equal(await auth.getUser(shadow), null, "the plain cookie can't add an account on https");
  const http = req("/api/me", { base: "http://flash-app.test", cookie: jarCookie({ def: ta, list: [ta, tb], http: true }), account: b });
  assert.equal((await auth.getUser(http))?.id, b, "it is the list on plain http");
  for (const mangled of ["%E0%A4%A", "1.....", `9.${tb}`, "1." + "x".repeat(5000), `1.${tb}.${"%"}`]) {
    const r = req("/api/me", { cookie: `flash_session=${ta}; __Host-flash_accounts=${mangled}` });
    assert.equal((await auth.getUser(r))?.id, a, mangled.slice(0, 20));
    const jar = await auth.jarSessions(r);
    assert.deepEqual(jar.entries.map((e) => e.user.id), [a]);
  }
});

// ---------------------------------------------------------------------------------------------
// Which account a request acts as

test("a browser with one account works exactly as before, with no header and no list cookie", async () => {
  const a = await account("la");
  const ta = await session(a);
  const patched = await meRoute.PATCH(req("/api/me", { method: "PATCH", cookie: `flash_session=${ta}`, json: { nickname: "Legacy" } }));
  assert.equal(patched.status, 200);
  assert.equal((await one<{ nickname: string }>("SELECT nickname FROM users WHERE id = ?", [a]))!.nickname, "Legacy");
  const got = await meRoute.GET(req("/api/me", { cookie: `flash_session=${ta}` }));
  assert.equal(got.status, 200);
  const me = (await got.json()) as { user: { id: string }; account: string; accounts: { id: string; email: string }[] };
  assert.equal(me.user.id, a);
  assert.equal(me.account, a);
  assert.deepEqual(me.accounts.map((x) => [x.id, x.email]), [[a, `${a}@x.io`]]);
  assert.deepEqual(setCookies(got), {}, "nothing new is set");
});

test("a tab's header acts as its account, on reads and on changes", async () => {
  const a = await account("ha");
  const b = await account("hb");
  const [ta, tb] = [await session(a), await session(b)];
  const cookie = jarCookie({ def: ta, list: [ta, tb] });
  assert.equal((await auth.getUser(req("/api/me", { cookie, account: b })))?.id, b);
  assert.equal((await auth.getUser(req("/api/me", { method: "PATCH", cookie, account: b, json: {} })))?.id, b);
  const patched = await meRoute.PATCH(req("/api/me", { method: "PATCH", cookie, account: b, json: { nickname: "Bee" } }));
  assert.equal(patched.status, 200);
  assert.equal((await one<{ nickname: string }>("SELECT nickname FROM users WHERE id = ?", [b]))!.nickname, "Bee");
  assert.equal((await one<{ nickname: string }>("SELECT nickname FROM users WHERE id = ?", [a]))!.nickname, "", "the default is untouched");
});

test("a header naming an account the browser isn't signed in to acts as nobody, never as the default", async () => {
  const a = await account("na");
  const b = await account("nb");
  const c = await account("nc");
  const [ta, tb] = [await session(a), await session(b, -1000)];
  await session(c);
  for (const cookie of [jarCookie({ def: ta, list: [ta, tb] }), `flash_session=${ta}`]) {
    for (const named of [c, b, "", "no such", "x".repeat(65), "a/b"]) {
      assert.equal(await auth.getUser(req("/api/me", { cookie, account: named })), null, `${named} with ${cookie.slice(0, 20)}`);
    }
    const res = await meRoute.GET(req("/api/me", { cookie, account: c }));
    assert.equal(res.status, 401);
  }
});

test("once a browser holds 2 accounts, a change without the tab's account is refused and charges nothing", async () => {
  const a = await account("pa");
  const b = await account("pb");
  const [ta, tb] = [await session(a), await session(b)];
  const cookie = jarCookie({ def: ta, list: [ta, tb] });
  const put = await projectRoute.PUT(req(`/api/projects/proj_${a}`, { method: "PUT", cookie, json: { name: "Renamed" } }), ctx({ id: `proj_${a}` }));
  assert.equal(put.status, 401);
  assert.equal((await one<{ name: string }>("SELECT name FROM projects WHERE id = ?", [`proj_${a}`]))!.name, "Notes");
  const patch = await meRoute.PATCH(req("/api/me", { method: "PATCH", cookie, json: { nickname: "X" } }));
  assert.equal(patch.status, 401);
  const before = [await ledger(a), await ledger(b)];
  const chat = await chatRoute.POST(
    req("/api/chat", { cookie, json: { projectId: `proj_${a}`, replyId: "r1", engine: "text", messages: [{ role: "user", content: "hi" }] } }),
  );
  assert.equal(chat.status, 401);
  assert.deepEqual([await ledger(a), await ledger(b)], before, "nothing held or charged to either account");
  const read = await meRoute.GET(req("/api/me", { cookie }));
  assert.equal(read.status, 200, "a read without a header is the default's");
  assert.equal(((await read.json()) as { user: { id: string } }).user.id, a);
  // The same change with the tab's account goes through.
  const pinned = await projectRoute.PUT(req(`/api/projects/proj_${a}`, { method: "PUT", cookie, account: a, json: { name: "Renamed" } }), ctx({ id: `proj_${a}` }));
  assert.equal(pinned.status, 200);
});

test("?as= names the account only on the links that need it, and only reads", async () => {
  const a = await account("aa");
  const b = await account("ab");
  const c = await account("ac");
  const [ta, tb] = [await session(a), await session(b)];
  await session(c);
  const cookie = jarCookie({ def: ta, list: [ta, tb] });
  for (const path of ["/api/sites/s1/versions?view=1", "/api/sites/s1/members?format=csv", "/api/sites/s1/orders", "/api/sites/s1/inbox?format=csv", "/api/payments/link"]) {
    assert.equal((await auth.getUser(req(path, { cookie, as: b })))?.id, b, path);
    assert.equal(await auth.getUser(req(path, { cookie, as: c })), null, `${path}: an account not signed in here`);
    assert.equal((await auth.getUser(req(path, { cookie, as: b, account: a })))?.id, a, `${path}: the header comes first`);
    assert.equal(await auth.getUser(req(path, { method: "POST", cookie, as: b })), null, `${path}: never on a change`);
  }
  assert.equal((await auth.getUser(req("/api/me", { cookie, as: b })))?.id, a, "ignored anywhere else");
  assert.equal((await auth.getUser(req("/api/sites/s1/records", { cookie, as: b })))?.id, a);
  assert.equal(auth.asParamAllowed("GET", "/api/sites/x/versions/extra"), false);
  assert.equal(auth.asParamAllowed("DELETE", "/api/sites/x/versions"), false);
});

test("a deleted account's session is dropped from the browser's accounts", async () => {
  const a = await account("da");
  const b = await account("db");
  const [ta, tb] = [await session(a), await session(b)];
  // Turso runs with foreign keys off, so the session row can outlive its account.
  await run("PRAGMA foreign_keys = OFF");
  await run("DELETE FROM users WHERE id = ?", [b]);
  await run("PRAGMA foreign_keys = ON");
  assert.equal(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", [b]), 1);
  const jar = await auth.jarSessions(req("/api/me", { cookie: jarCookie({ def: ta, list: [ta, tb] }) }));
  assert.deepEqual(jar.entries.map((e) => e.user.id), [a]);
  assert.equal(jar.stale, true, "its list is rewritten when next written");
  assert.equal(await auth.getUser(req("/api/me", { cookie: jarCookie({ def: ta, list: [ta, tb] }), account: b })), null);
  const listed = await accountsRoute.GET(req("/api/auth/accounts", { cookie: jarCookie({ def: ta, list: [ta, tb] }) }));
  assert.deepEqual(((await listed.json()) as { accounts: { id: string }[] }).accounts.map((x) => x.id), [a]);
  assert.match(setCookies(listed)["__Host-flash_accounts"].attrs, /Max-Age=0/, "a list of one is no list");
});

// ---------------------------------------------------------------------------------------------
// Adding an account: every way of signing in adds to the browser's accounts

test("signing in to a second account with a password adds it and makes it the default", async () => {
  const a = await account("sa");
  const b = await account("sb");
  const first = await login(`${a}@x.io`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, twoFactor: false, account: a });
  let cookie = after("", first);
  assert.equal(setCookies(first)["__Host-flash_accounts"], undefined, "no list for one account");
  const ta = setCookies(first).flash_session.value;
  const second = await login(`${b}@x.io`, cookie);
  assert.deepEqual(await second.json(), { ok: true, twoFactor: false, account: b });
  cookie = after(cookie, second);
  const tb = setCookies(second).flash_session.value;
  assert.equal(await userOf(tb), b);
  assert.equal(await userOf(ta), a, "the first account is still signed in");
  assert.deepEqual(listOf(second), [ta, tb]);
  assert.match(setCookies(second)["__Host-flash_accounts"].attrs, /HttpOnly/);
});

test("signing in again to an account the browser holds keeps its session, without two-step again", async () => {
  const a = await account("ra");
  const b = await account("rb");
  await twoStep(a);
  const { cookie, tokens } = await browser(a, b);
  const rows = await sessionHashes();
  const res = await login(`${a}@x.io`, cookie);
  assert.deepEqual(await res.json(), { ok: true, twoFactor: false, account: a });
  assert.deepEqual(await sessionHashes(), rows, "no new session");
  assert.equal(await count("SELECT COUNT(*) AS n FROM two_factor_pending WHERE user_id = ?", [a]), 0);
  const set = setCookies(res).flash_session;
  assert.equal(set.value, tokens[0], "the session it already had");
  assert.ok(set.maxAge! < 30 * 86400 && set.maxAge! > 29 * 86400, String(set.maxAge));
});

test("a browser holds at most 5 accounts: a sixth is refused before anything is made", async () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await account(`cap${i}`));
  await twoStep(ids[5]);
  const { cookie } = await browser(...ids.slice(0, 5));
  const rows = await sessionHashes();
  const pending = await count("SELECT COUNT(*) AS n FROM two_factor_pending");
  const sixth = await login(`${ids[5]}@x.io`, cookie);
  assert.equal(sixth.status, 409);
  const body = (await sixth.json()) as { code: string; error: string };
  assert.equal(body.code, "too_many_accounts");
  assert.equal(body.error, "You're signed in to 5 accounts on this browser. Log out of one first.");
  assert.deepEqual(await sessionHashes(), rows);
  assert.equal(await count("SELECT COUNT(*) AS n FROM two_factor_pending"), pending, "no two-step sign-in waits either");
  const again = await login(`${ids[2]}@x.io`, cookie);
  assert.equal(again.status, 200, "one of the 5 again is fine");
  assert.equal(((await again.json()) as { account: string }).account, ids[2]);
  assert.deepEqual(await sessionHashes(), rows);
});

test("signing up at 5 accounts makes no account, and signing up while signed in earns no referral", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await account(`su${i}`));
  const full = await browser(...ids);
  const users = await count("SELECT COUNT(*) AS n FROM users");
  const refused = await signupRoute.POST(req("/api/auth/signup", { cookie: full.cookie, json: { email: "new6@x.io", password: "longenough1" } }));
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { code: string }).code, "too_many_accounts");
  assert.equal(await count("SELECT COUNT(*) AS n FROM users"), users);

  const code = await referralCode(ids[0]);
  const signedIn = (await browser(ids[0])).cookie;
  const referredBy = async (email: string) => (await one<{ r: string | null }>("SELECT referred_by AS r FROM users WHERE email = ?", [email]))!.r;
  const own = await signupRoute.POST(req("/api/auth/signup", { cookie: `${signedIn}; flash_ref=${code}`, json: { email: "second@x.io", password: "longenough1" } }));
  assert.equal(own.status, 200);
  const made = (await own.json()) as { account: string };
  assert.equal(await referredBy("second@x.io"), null, "someone adding their own account doesn't refer themselves");
  assert.equal(listOf(own).length, 2);
  assert.equal(setCookies(own).flash_session.value && (await userOf(setCookies(own).flash_session.value)), made.account);
  const friend = await signupRoute.POST(req("/api/auth/signup", { cookie: `flash_ref=${code}`, json: { email: "friend@x.io", password: "longenough1" } }));
  assert.equal(friend.status, 200);
  assert.equal(await referredBy("friend@x.io"), ids[0], "signed out, the referral still counts");
});

test("Google sign-in at 5 accounts looks the account up without making it, and makes nothing", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await account(`go${i}`));
  const { cookie } = await browser(...ids);
  const profile = { provider: "google" as const, subject: "g-new-6", email: "sixth@gmail.com", emailVerified: true, name: "Six" };
  const before = [await count("SELECT COUNT(*) AS n FROM users"), await count("SELECT COUNT(*) AS n FROM identities")];
  assert.equal(await providerAccountId(profile), null, "a new person");
  assert.equal(await providerAccountId({ ...profile, subject: "g-x", email: `${ids[1]}@x.io` }), ids[1], "by the email Google confirmed");
  assert.equal(await providerAccountId({ ...profile, subject: "g-x", email: `${ids[1]}@x.io`, emailVerified: false }), null);
  assert.deepEqual([await count("SELECT COUNT(*) AS n FROM users"), await count("SELECT COUNT(*) AS n FROM identities")], before);

  /** Google's sign-in page sending the browser back, with Google's token endpoint stood in for. */
  const back = async (browserCookie: string, who: typeof profile) => {
    const state = oauth.newState("google", "/");
    const claims = { iss: "https://accounts.google.com", aud: "gid", exp: Date.now() / 1000 + 600, nonce: state.nonce, sub: who.subject, email: who.email, email_verified: true, name: who.name };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ access_token: "at", id_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y` })) as typeof fetch;
    try {
      const stateCookie = oauth.stateCookie(state, true).split(";")[0];
      return await callbackRoute.GET(
        req(`/api/auth/oauth/google/callback?state=${state.state}&code=c1`, { cookie: `${browserCookie}; ${stateCookie}`, origin: null }),
        ctx({ provider: "google" }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const refused = await back(cookie, profile);
  assert.equal(refused.status, 303);
  assert.equal(refused.headers.get("location"), `${ORIGIN}/?auth_error=too_many_accounts`);
  assert.deepEqual([await count("SELECT COUNT(*) AS n FROM users"), await count("SELECT COUNT(*) AS n FROM identities")], before);
  // With room, the new account is added and the tab is told which one it is on now.
  const two = await browser(ids[0]);
  const added = await back(two.cookie, profile);
  const made = (await one<{ id: string }>("SELECT id FROM users WHERE email = 'sixth@gmail.com'"))!.id;
  assert.equal(added.headers.get("location"), `${ORIGIN}/?as=${made}`);
  assert.deepEqual(listOf(added).length, 2);
});

test("an email sign-in link at 5 accounts is refused and kept for later", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await account(`el${i}`));
  const { cookie } = await browser(...ids);
  const token = await createSignInLink("brand-new@x.io", "/");
  const res = await emailLinkRoute.POST(req("/api/auth/email-link", { cookie, json: { token, email: "brand-new@x.io" } }));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "too_many_accounts");
  assert.equal(await count("SELECT COUNT(*) AS n FROM sign_in_links WHERE token_hash = ?", [sha256(token)]), 1, "not used up");
  assert.equal(await count("SELECT COUNT(*) AS n FROM users WHERE email = 'brand-new@x.io'"), 0);
  // For an account the browser already holds it works, and says which account.
  const known = await createSignInLink(`${ids[3]}@x.io`, "/");
  const ok = await emailLinkRoute.POST(req("/api/auth/email-link", { cookie, json: { token: known, email: `${ids[3]}@x.io` } }));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { account: string }).account, ids[3]);
});

test("two-step sign-in while signed in to another account adds the account only after the code", async () => {
  const a = await account("ta");
  const b = await account("tb");
  const secret = await twoStep(b);
  const start = await browser(a);
  const res = await login(`${b}@x.io`, start.cookie);
  assert.deepEqual(await res.json(), { ok: true, twoFactor: true });
  assert.equal(setCookies(res).flash_session, undefined, "still on the first account");
  const waiting = after(start.cookie, res);
  const done = await twoFactorRoute.POST(req("/api/auth/two-factor", { cookie: waiting, json: { code: codeFor(secret, stepAt(Date.now())) } }));
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as { account: string }).account, b);
  assert.deepEqual(listOf(done).length, 2);
  assert.equal(await userOf(listOf(done)[0]), a);
  assert.equal(await userOf(listOf(done)[1]), b);

  // The browser fills up while the code waits: finishing waits too, and the code still works later.
  const c = await account("tc");
  const csecret = await twoStep(c);
  const others = [];
  for (let i = 0; i < 4; i++) others.push(await account(`tf${i}`));
  const four = await browser(...others);
  const asked = await login(`${c}@x.io`, four.cookie);
  assert.equal(((await asked.json()) as { twoFactor: boolean }).twoFactor, true);
  const pendingCookie = Object.entries(setCookies(asked)).find(([k]) => k === "flash_2fa")![1].value;
  const fifth = await session(await account("tf4"));
  const full = `${jarCookie({ def: fifth, list: [...four.tokens, fifth] })}; flash_2fa=${pendingCookie}`;
  const code = codeFor(csecret, stepAt(Date.now()));
  const refused = await twoFactorRoute.POST(req("/api/auth/two-factor", { cookie: full, json: { code } }));
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { code: string }).code, "too_many_accounts");
  assert.equal(await count("SELECT COUNT(*) AS n FROM two_factor_pending WHERE user_id = ?", [c]), 1, "still waiting");
  // After logging out of one, the same code finishes it.
  const roomy = `${jarCookie({ def: fifth, list: [...four.tokens.slice(1), fifth] })}; flash_2fa=${pendingCookie}`;
  const finished = await twoFactorRoute.POST(req("/api/auth/two-factor", { cookie: roomy, json: { code } }));
  assert.equal(finished.status, 200);
  assert.equal(listOf(finished).length, 5);
});

test("a reset link at 5 accounts is kept; for an account the browser holds, its new session takes its place", async () => {
  const { sendReset } = await import("../src/lib/server/account.ts");
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await account(`rs${i}`));
  const full = await browser(...ids.slice(0, 5));
  const link = (await sendReset({ id: ids[5], email: `${ids[5]}@x.io` }, ORIGIN))!;
  const token = new URL(link).searchParams.get("token")!;
  const refused = await resetRoute.POST(req("/api/auth/reset", { cookie: full.cookie, json: { token, password: "brandnew123", email: `${ids[5]}@x.io` } }));
  assert.equal(refused.status, 409);
  assert.equal(await count("SELECT COUNT(*) AS n FROM email_tokens WHERE token_hash = ?", [sha256(token)]), 1, "the link still works later");

  const mine = (await sendReset({ id: ids[1], email: `${ids[1]}@x.io` }, ORIGIN))!;
  const res = await resetRoute.POST(
    req("/api/auth/reset", { cookie: full.cookie, json: { token: new URL(mine).searchParams.get("token"), password: "brandnew123", email: `${ids[1]}@x.io` } }),
  );
  assert.equal(res.status, 200);
  const list = listOf(res);
  assert.equal(list.length, 5);
  assert.equal(await userOf(full.tokens[1]), null, "the old session ended with the reset");
  assert.notEqual(list[1], full.tokens[1]);
  assert.equal(await userOf(list[1]), ids[1], "the new one in the same place");
  assert.deepEqual(list.filter((_, i) => i !== 1), full.tokens.filter((_, i) => i !== 1));
  assert.equal(await userOf(setCookies(res).flash_session.value), ids[1], "and the default");
});

test("changing the password of a tab's account that isn't the default leaves the default and the others alone", async () => {
  const a = await account("pwa");
  const b = await account("pwb");
  const ta = await session(a);
  const tb = await session(b);
  const cookie = jarCookie({ def: ta, list: [ta, tb] });
  const res = await passwordRoute.POST(req("/api/me/password", { cookie, account: b, json: { current: "secret123", next: "another123" } }));
  assert.equal(res.status, 200);
  assert.equal(setCookies(res).flash_session, undefined, "the default stays");
  const list = listOf(res);
  assert.equal(list[0], ta);
  assert.notEqual(list[1], tb);
  assert.equal(await userOf(list[1]), b);
  assert.equal(await userOf(tb), null, "the old session ended");
  assert.equal(await userOf(ta), a, "the other account is untouched");
});

// ---------------------------------------------------------------------------------------------
// Switching

test("Switch account works only from Flash's own page", async () => {
  const a = await account("swa");
  const b = await account("swb");
  const { cookie } = await browser(a, b);
  const plain = new Request(`${ORIGIN}/api/auth/switch`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "text/plain" }, body: JSON.stringify({ account: a }) });
  for (const r of [
    plain,
    req("/api/auth/switch", { cookie, json: { account: a }, site: "cross-site" }),
    req("/api/auth/switch", { cookie, json: { account: a }, origin: "https://evil.example" }),
  ]) {
    const res = await switchRoute.POST(r);
    assert.equal(res.status, 403);
    assert.deepEqual(res.headers.getSetCookie(), []);
  }
});

test("switching to an account the browser isn't signed in to is refused", async () => {
  const a = await account("swna");
  const b = await account("swnb");
  const c = await account("swnc");
  await session(c);
  const { cookie } = await browser(a, b);
  for (const id of [c, "nobody", "", "bad id!"]) {
    const res = await switchRoute.POST(req("/api/auth/switch", { cookie, json: { account: id } }));
    assert.equal(res.status, 404, id);
    assert.equal(((await res.json()) as { code: string }).code, "not_signed_in");
    assert.deepEqual(res.headers.getSetCookie(), []);
  }
});

test("a switch makes the account's existing session the default and changes no session", async () => {
  const a = await account("swxa");
  const b = await account("swxb");
  const tb = await session(b, 10 * 86_400_000);
  const ta = await session(a);
  const before = await sessionHashes();
  const res = await switchRoute.POST(req("/api/auth/switch", { cookie: jarCookie({ def: ta, list: [tb, ta] }), json: { account: b } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, account: b });
  const set = setCookies(res);
  assert.equal(set.flash_session.value, tb);
  assert.ok(Math.abs(set.flash_session.maxAge! - 10 * 86_400) <= 2, String(set.flash_session.maxAge));
  assert.match(set.flash_session.attrs, /HttpOnly/);
  assert.equal(set["__Host-flash_accounts"], undefined, "the list was already right");
  assert.deepEqual(await sessionHashes(), before, "no session made, renewed or ended");
});

// ---------------------------------------------------------------------------------------------
// The accounts list

test("the accounts list drops ended sessions and is the only place a new default is chosen", async () => {
  const a = await account("ala");
  const b = await account("alb");
  const c = await account("alc");
  const ta = await session(a);
  const tb = await session(b);
  const tc = await session(c);
  const dead = await session(b, -1000);
  // c's session is the default and has ended.
  await run("DELETE FROM sessions WHERE token_hash = ?", [sha256(tc)]);
  const cookie = jarCookie({ def: tc, list: [dead, ta, tc, tb] });
  const me = await meRoute.GET(req("/api/me", { cookie }));
  assert.equal(me.status, 401, "/api/me never picks another account");
  assert.deepEqual(me.headers.getSetCookie(), []);
  const res = await accountsRoute.GET(req("/api/auth/accounts", { cookie }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { default: string; accounts: { id: string; email: string; name: string; nickname: string }[] };
  assert.deepEqual(body.accounts, [
    { id: a, email: `${a}@x.io`, name: `User ${a}`, nickname: "" },
    { id: b, email: `${b}@x.io`, name: `User ${b}`, nickname: "" },
  ]);
  assert.equal(body.default, a);
  const set = setCookies(res);
  assert.equal(set.flash_session.value, ta, "the first account left is the default now");
  assert.deepEqual(listOf(res), [ta, tb]);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const signedOut = await accountsRoute.GET(req("/api/auth/accounts"));
  assert.deepEqual(await signedOut.json(), { default: null, accounts: [] });
});

// ---------------------------------------------------------------------------------------------
// Logging out

/** An app of the user's, opened as owner from a session: the owner key it gives. */
async function ownerKey(userId: string, token: string): Promise<{ slug: string; key: string }> {
  const slug = `app-${userId}`;
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, 'App', '<p>hi</p>', 0, 0)", [slug, userId]);
  const code = (await siteOwner.newOwnerCode(slug, userId, token))!;
  const { key } = (await siteOwner.ownerKeyForCode(slug, code))!;
  assert.equal(await siteOwner.isOwnerKey(slug, key), true);
  return { slug, key };
}
/** A connected app's token and an unused code for the user, as Claude's connector would hold. */
async function connected(userId: string) {
  await run("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at, created_at) VALUES (?, 'access', 'claude', ?, ?, 0)", [randomId(16), userId, Date.now() + 86_400_000]);
  await run("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES (?, 'claude', ?, 'https://claude.ai/cb', 'x', ?)", [randomId(16), userId, Date.now() + 60_000]);
}
const rows = async (table: string, userId: string) => count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [userId]);
const logout = (cookie: string, json: unknown, account?: string) => logoutRoute.POST(req("/api/auth/logout", { cookie, json, account }));

test("logging out works only from Flash's own page", async () => {
  const a = await account("loa");
  const b = await account("lob");
  const ta = await session(a);
  // A Log out with no body, as a tab loaded before this change sends it.
  const bare = (cookie: string, headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin" }) =>
    logoutRoute.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie, ...headers } }));
  const refused = [
    () => bare(`flash_session=${ta}`, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
    () => bare(`flash_session=${ta}`, { origin: "https://evil.example" }),
    () => bare(`flash_session=${ta}`, { origin: "null" }),
    () => bare(`flash_session=${ta}`, {}),
    () => bare(`flash_session=${ta}`, { origin: ORIGIN, "sec-fetch-site": "cross-site" }),
    () => bare(`flash_session=${ta}`, { origin: ORIGIN, "content-type": "text/plain" }),
    () => logoutRoute.POST(req("/api/auth/logout", { cookie: `flash_session=${ta}`, json: {}, site: "cross-site" })),
    () => logoutRoute.POST(req("/api/auth/logout", { cookie: `flash_session=${ta}`, json: {}, origin: "https://evil.example" })),
  ];
  for (const send of refused) {
    const res = await send();
    assert.equal(res.status, 403);
    assert.deepEqual(res.headers.getSetCookie(), []);
    assert.equal(await userOf(ta), a);
  }
  // With 2 accounts here, the old page's Log out can't say which: it changes nothing.
  const { cookie, tokens } = await browser(a, b);
  for (const res of [await bare(cookie), await bare(cookie, { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-flash-account": a })]) {
    assert.equal(res.status, 403);
    assert.deepEqual(res.headers.getSetCookie(), []);
  }
  for (const token of tokens) assert.notEqual(await userOf(token), null);
  // With one account, the old page's Log out ends its session here, as it always did.
  const res = await bare(`flash_session=${ta}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), [auth.clearSessionCookie()]);
  assert.equal(await userOf(ta), null);
});

test("Log out of this account ends only that account's session here, and the next one becomes the default", async () => {
  const a = await account("lta");
  const b = await account("ltb");
  const tb = await session(b);
  const ta = await session(a);
  const elsewhere = await session(a);
  const owned = await ownerKey(a, ta);
  const res = await logout(jarCookie({ def: ta, list: [tb, ta] }), {}, a);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, next: { id: b, email: `${b}@x.io` } });
  const set = setCookies(res);
  assert.equal(set.flash_session.value, tb);
  assert.equal(set["__Host-flash_accounts"].maxAge, 0, "one account left, so no list");
  assert.equal(await userOf(ta), null);
  assert.equal(await userOf(elsewhere), a, "a's other device stays signed in");
  assert.equal(await userOf(tb), b);
  assert.equal(await siteOwner.isOwnerKey(owned.slug, owned.key), false, "owner mode opened from that session ends with it");
});

test("with 2 accounts, a log out that doesn't name the tab's account changes nothing", async () => {
  const a = await account("lna");
  const b = await account("lnb");
  const c = await account("lnc");
  await connected(a);
  await connected(b);
  const ta = await session(a);
  const tb = await session(b);
  const tc = await session(c);
  const cookie = jarCookie({ def: tb, list: [ta, tb] });
  const before = [await sessionHashes(), await rows("oauth_tokens", a), await rows("oauth_tokens", b), await rows("oauth_codes", a)];
  for (const [body, account] of [[{}, undefined], [{ everywhere: true }, undefined], [{}, c], [{ everywhere: true }, c], [{}, "bad id!"]] as const) {
    const res = await logout(cookie, body, account);
    assert.equal(res.status, 409, JSON.stringify([body, account]));
    assert.equal(((await res.json()) as { code: string }).code, "account_required");
    assert.deepEqual(res.headers.getSetCookie(), []);
  }
  assert.deepEqual([await sessionHashes(), await rows("oauth_tokens", a), await rows("oauth_tokens", b), await rows("oauth_codes", a)], before);
  assert.equal(await userOf(tc), c);
});

test("a tab still showing an account that isn't the default logs out everywhere only that account", async () => {
  const a = await account("lea");
  const b = await account("leb");
  await connected(a);
  await connected(b);
  const ta = await session(a);
  const otherDevice = await session(a);
  const tb = await session(b);
  const bElsewhere = await session(b);
  const res = await logout(jarCookie({ def: tb, list: [ta, tb] }), { everywhere: true }, a);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, next: { id: b, email: `${b}@x.io` } });
  const set = setCookies(res);
  assert.equal(set.flash_session, undefined, "b stays the default");
  assert.equal(set["__Host-flash_accounts"].maxAge, 0);
  for (const token of [ta, otherDevice]) assert.equal(await userOf(token), null);
  assert.deepEqual([await rows("oauth_tokens", a), await rows("oauth_codes", a)], [0, 0], "a's connected apps are disconnected");
  for (const token of [tb, bElsewhere]) assert.equal(await userOf(token), b);
  assert.deepEqual([await rows("oauth_tokens", b), await rows("oauth_codes", b)], [1, 1]);
});

test("Log out of all accounts ends this browser's sessions only, and clears both cookies", async () => {
  const a = await account("laa");
  const b = await account("lab");
  const ta = await session(a);
  const aElsewhere = await session(a);
  const tb = await session(b);
  const res = await logout(jarCookie({ def: tb, list: [ta, tb] }), { all: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, next: null });
  const set = setCookies(res);
  assert.equal(set.flash_session.maxAge, 0);
  assert.equal(set["__Host-flash_accounts"].maxAge, 0);
  assert.equal(await userOf(ta), null);
  assert.equal(await userOf(tb), null);
  assert.equal(await userOf(aElsewhere), a, "other devices stay signed in");
});

test("a browser with one account logs out exactly as before, even when its session already ended", async () => {
  const a = await account("lla");
  const ta = await session(a);
  const res = await logout(`flash_session=${ta}`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, next: null });
  assert.deepEqual(res.headers.getSetCookie(), [auth.clearSessionCookie()]);
  assert.equal(await count("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?", [sha256(ta)]), 0);
  const ended = await session(a, -1000);
  const again = await logout(`flash_session=${ended}`, {});
  assert.equal(again.status, 200);
  assert.deepEqual(again.headers.getSetCookie(), [auth.clearSessionCookie()]);
  assert.equal(await count("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?", [sha256(ended)]), 0, "the ended row goes too");
  const tabbed = await session(a);
  const pinned = await logout(`flash_session=${tabbed}`, { everywhere: true }, a);
  assert.equal(pinned.status, 200);
  assert.deepEqual(pinned.headers.getSetCookie(), [auth.clearSessionCookie()]);
  assert.equal(await rows("sessions", a), 0);
});

// ---------------------------------------------------------------------------------------------
// Links and flows that belong to one account

/** The "Connect to Flash" page's answer, as its form posts it. */
function consent(cookie: string, fields: Record<string, string>) {
  return consentRoute.POST(
    new Request(`${ORIGIN}/api/oauth/authorize`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );
}

test("Connect to Flash connects the account the page showed, and nothing when the accounts here changed", async () => {
  const a = await account("cna");
  const b = await account("cnb");
  const c = await account("cnc");
  await session(c);
  const app = "https://claude.ai/api/mcp/auth_callback";
  const reg = await registerClient({ client_name: "Claude", redirect_uris: [app] });
  assert.ok(!("error" in reg));
  const asked = { client_id: reg.client.id, redirect_uri: app, response_type: "code", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "st" };
  const { cookie } = await browser(a, b);
  const codes = (id: string) => count("SELECT COUNT(*) AS n FROM oauth_codes WHERE user_id = ?", [id]);

  const allowed = await consent(cookie, { ...asked, account: a, decision: "allow" });
  assert.equal(allowed.status, 303);
  const to = new URL(allowed.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, app);
  assert.ok(to.searchParams.get("code"));
  assert.deepEqual([await codes(a), await codes(b)], [1, 0], "the shown account, not the default");

  for (const fields of [{ ...asked, account: c, decision: "allow" }, { ...asked, account: "bad id!", decision: "allow" }, { ...asked, decision: "allow" }]) {
    const res = await consent(cookie, fields);
    assert.equal(res.status, 303);
    const back = new URL(res.headers.get("location")!, ORIGIN);
    assert.equal(back.pathname, "/oauth/authorize");
    assert.equal(back.searchParams.get("changed"), "1");
    assert.equal(back.searchParams.get("account"), null);
    assert.equal(back.searchParams.get("decision"), null);
    assert.equal(back.searchParams.get("client_id"), reg.client.id);
  }
  assert.deepEqual([await codes(a), await codes(b), await codes(c)], [1, 0, 0], "no code for anyone");

  // A page from before accounts could be switched, in a browser with one account: as before.
  const solo = await session(c);
  const legacy = await consent(`flash_session=${solo}`, { ...asked, decision: "allow" });
  assert.ok(new URL(legacy.headers.get("location")!).searchParams.get("code"));
  assert.equal(await codes(c), 1);
});

test("a confirmation link confirms its account when it is any account signed in here, and opens Flash as it", async () => {
  const a = await account("vfa");
  const b = await account("vfb");
  await run("UPDATE users SET verified_at = 0 WHERE id = ?", [b]);
  const { cookie } = await browser(b, a);
  const link = (await sendVerification({ id: b, email: `${b}@x.io` }, ORIGIN))!;
  const res = await verifyRoute.GET(req(new URL(link).pathname + new URL(link).search, { cookie }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `${ORIGIN}/?verified=1&as=${b}`);
  assert.ok(Number((await one<{ v: number }>("SELECT verified_at AS v FROM users WHERE id = ?", [b]))!.v) > 0);
  const elsewhere = await verifyRoute.GET(req(new URL(link).pathname + new URL(link).search, { cookie: (await browser(a)).cookie }));
  assert.equal(elsewhere.headers.get("location"), `${ORIGIN}/?verified=invalid`, "used once");
});

test("an invitation for another account signed in here asks to switch, and is kept for it", async () => {
  const owner = await account("tio");
  const a = await account("tia");
  const b = await account("tib");
  await run("INSERT INTO teams (id, owner_id, created_at) VALUES ('team_ti', ?, 0)", [owner]);
  const token = randomId(32);
  await run("INSERT INTO team_invites (id, token_hash, team_id, email, email_key, expires_at, created_at) VALUES ('inv_ti', ?, 'team_ti', ?, ?, ?, 0)", [sha256(token), `${b}@x.io`, `${b}@x.io`, Date.now() + 86_400_000]);
  const { cookie } = await browser(b, a);
  const res = await acceptRoute.POST(req("/api/team/accept", { cookie, account: a, json: { token } }));
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code: string; forAccount: { id: string; email: string }; error: string };
  assert.equal(body.code, "other_account");
  assert.deepEqual(body.forAccount, { id: b, email: `${b}@x.io` });
  assert.match(body.error, /Switch to that account to join/);
  assert.equal(await count("SELECT COUNT(*) AS n FROM team_invites WHERE id = 'inv_ti'"), 1, "the invitation is still there");
  assert.equal(await count("SELECT COUNT(*) AS n FROM team_members"), 0);
  // For an address no account here has: the usual answer.
  const stranger = await acceptRoute.POST(req("/api/team/accept", { cookie: (await browser(a)).cookie, json: { token } }));
  assert.equal(stranger.status, 403);
});

/** A connector sign-in under way for the user, as its start leaves it: the state it went out with. */
async function flow(userId: string, provider: string, endpoints = "{}"): Promise<string> {
  const state = randomId(24);
  await run(
    `INSERT INTO connect_flows (state_hash, user_id, enc_verifier, provider, issuer, resource, client_reg_id, redirect_uri, endpoints_json, created_at, expires_at)
     VALUES (?, ?, 'v', ?, 'https://auth.example', 'https://mcp.example', 'reg', ?, ?, ?, ?)`,
    [sha256(state), userId, provider, `${ORIGIN}/api/connect/x/callback`, endpoints, Date.now(), Date.now() + 600_000],
  );
  return state;
}
const flowLeft = async (state: string) => count("SELECT COUNT(*) AS n FROM connect_flows WHERE state_hash = ?", [sha256(state)]);
const outcomeOf = (res: Response) => {
  const to = new URL(res.headers.get("location")!);
  return { outcome: to.searchParams.get("connect"), as: to.searchParams.get("as") };
};

test("a connector's sign-in finishes for the account that started it, whichever is the default", async () => {
  const a = await account("cfa");
  const b = await account("cfb");
  const c = await account("cfc");
  await session(c);
  const { cookie } = await browser(a, b);
  // The person said no at the service: the flow is taken (so it was found for its account) and nothing kept.
  const mine = await flow(a, "notion");
  assert.deepEqual(outcomeOf(await mcpCallback.GET(req(`/api/connect/mcp/callback?state=${mine}&error=access_denied`, { cookie }))), { outcome: "cancelled", as: a });
  assert.equal(await flowLeft(mine), 0);
  const theirs = await flow(c, "notion");
  assert.deepEqual(outcomeOf(await mcpCallback.GET(req(`/api/connect/mcp/callback?state=${theirs}&error=access_denied`, { cookie }))), { outcome: "expired", as: null });
  assert.equal(await flowLeft(theirs), 1, "nobody here can take another account's flow");
  // A GitHub or Google flow is only ever taken by its own callback.
  const gh = await flow(a, "github", JSON.stringify({ github: "authorize" }));
  assert.equal(outcomeOf(await mcpCallback.GET(req(`/api/connect/mcp/callback?state=${gh}&error=access_denied`, { cookie }))).outcome, "expired");
  assert.equal(await flowLeft(gh), 1);
  // One account in the browser: the address back is as before.
  const solo = await flow(c, "notion");
  assert.deepEqual(outcomeOf(await mcpCallback.GET(req(`/api/connect/mcp/callback?state=${solo}&error=access_denied`, { cookie: (await browser(c)).cookie }))), { outcome: "cancelled", as: null });
});

test("GitHub's sign-in and installation, and Google Drive's sign-in, finish for the account that started them", async () => {
  const a = await account("gfa");
  const b = await account("gfb");
  const c = await account("gfc");
  await session(c);
  const { cookie } = await browser(a, b);
  const step = await flow(a, "github", JSON.stringify({ github: "authorize" }));
  assert.deepEqual(outcomeOf(await githubCallback.GET(req(`/api/connect/github/callback?state=${step}&error=access_denied`, { cookie }))), { outcome: "cancelled", as: a });
  assert.equal(await flowLeft(step), 0);
  // The redirect after an installation carries no state: the newest installation any account here started.
  const older = await flow(b, "github", JSON.stringify({ github: "install" }));
  await run("UPDATE connect_flows SET created_at = created_at - 60000 WHERE state_hash = ?", [sha256(older)]);
  const install = await flow(a, "github", JSON.stringify({ github: "install" }));
  const theirs = await flow(c, "github", JSON.stringify({ github: "install" }));
  await run("UPDATE connect_flows SET created_at = created_at + 60000 WHERE state_hash = ?", [sha256(theirs)]);
  assert.deepEqual(outcomeOf(await githubCallback.GET(req("/api/connect/github/callback?installation_id=42&setup_action=install&error=access_denied", { cookie }))), { outcome: "cancelled", as: a });
  assert.deepEqual([await flowLeft(install), await flowLeft(older), await flowLeft(theirs)], [0, 1, 1], "only that one is taken");
  const cState = await flow(c, "github", JSON.stringify({ github: "authorize" }));
  assert.equal(outcomeOf(await githubCallback.GET(req(`/api/connect/github/callback?state=${cState}&error=access_denied`, { cookie }))).outcome, "expired");
  assert.equal(await flowLeft(cState), 1);

  const drive = await flow(a, "google-drive");
  assert.deepEqual(outcomeOf(await googleCallback.GET(req(`/api/connect/google/callback?state=${drive}&error=access_denied`, { cookie }))), { outcome: "cancelled", as: a });
  assert.equal(await flowLeft(drive), 0);
  const cDrive = await flow(c, "google-drive");
  assert.equal(outcomeOf(await googleCallback.GET(req(`/api/connect/google/callback?state=${cDrive}&error=access_denied`, { cookie }))).outcome, "expired");
  assert.equal(await flowLeft(cDrive), 1);
});

test("auto top-up, Google Drive, Made with Flash and the reports dashboard act as the tab's account", async () => {
  const a = await account("nra");
  const b = await account("nrb");
  const stranger = await account("nrc");
  await session(stranger);
  // b is the browser's default; the tab shows a.
  const { cookie } = await browser(a, b);
  const json = (account: string | undefined, body: unknown) => ({ cookie, account, json: body });

  // Auto top-up: reads and saves are the tab's account's, never the default's.
  await run("INSERT INTO auto_topups (user_id, enabled, pack, below, payment_method, updated_at) VALUES (?, 1, 'x', 100, 'pm_a', 0)", [a]);
  assert.equal((await (await autoTopUpRoute.GET(req("/api/billing/auto-topup", { cookie, account: a }))).json()).enabled, true);
  const shown = await (await autoTopUpRoute.GET(req("/api/billing/auto-topup", { cookie }))).json();
  assert.equal(shown.enabled, false, "with no account named, a read is the default's (b)");
  const choice = { enabled: false, pack: shown.pack, below: shown.below };
  assert.equal((await autoTopUpRoute.POST(req("/api/billing/auto-topup", json(undefined, choice)))).status, 401, "a change must name the tab's account");
  assert.equal((await autoTopUpRoute.POST(req("/api/billing/auto-topup", json(stranger, choice)))).status, 401, "never an account not signed in here");
  assert.equal(await count("SELECT COUNT(*) AS n FROM auto_topups WHERE user_id IN (?, ?)", [b, stranger]), 0);
  assert.equal((await autoTopUpRoute.POST(req("/api/billing/auto-topup", json(a, choice)))).status, 200);
  assert.equal(await count("SELECT COUNT(*) AS n FROM auto_topups WHERE user_id = ? AND enabled = 0", [a]), 1, "turned off for a");
  assert.equal(await count("SELECT COUNT(*) AS n FROM auto_topups WHERE user_id = ?", [b]), 0, "b untouched");

  // Connecting Google Drive starts for the tab's account; the Picker and picked files are its own.
  assert.equal((await driveStartRoute.POST(req("/api/connect/google/start", json(undefined, {})))).status, 401);
  assert.equal((await driveStartRoute.POST(req("/api/connect/google/start", json(stranger, {})))).status, 401);
  const started = await driveStartRoute.POST(req("/api/connect/google/start", json(a, {})));
  assert.equal(started.status, 200);
  assert.deepEqual(
    (await all<{ user_id: string }>("SELECT user_id FROM connect_flows WHERE provider = 'google-drive' AND user_id IN (?, ?, ?)", [a, b, stranger])).map((r) => r.user_id),
    [a],
  );
  for (const route of [pickerTokenRoute, driveFilesRoute]) {
    const path = route === pickerTokenRoute ? "/api/connect/google/picker-token" : "/api/connect/google/files";
    const body = { connectionId: "conn_none", ids: ["f1"] };
    assert.equal((await route.POST(req(path, json(undefined, body)))).status, 401, path);
    assert.equal((await route.POST(req(path, json(stranger, body)))).status, 401, path);
    // As a: a has no such connection (not "signed out").
    assert.equal((await route.POST(req(path, json(a, body)))).status, 404, path);
  }

  // Made with Flash: only the tab's account's own app.
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('mw-b', ?, 'B', '<p>b</p>', 0, 0)", [b]);
  const made = (account?: string, method = "GET") =>
    method === "GET"
      ? madeWithRoute.GET(req("/api/sites/mw-b/made-with", { cookie, account }), ctx({ slug: "mw-b" }))
      : madeWithRoute.PATCH(req("/api/sites/mw-b/made-with", { method: "PATCH", cookie, account, json: { on: false } }), ctx({ slug: "mw-b" }));
  assert.equal((await made(a)).status, 404, "a tab showing a doesn't see b's app");
  assert.equal((await made(b)).status, 200);
  assert.equal((await made(undefined, "PATCH")).status, 401);
  assert.equal((await made(a, "PATCH")).status, 404);

  // The reports dashboard: only while the tab shows the owner's account, whichever is the default.
  const admins = process.env.FLASH_ADMIN_EMAILS;
  process.env.FLASH_ADMIN_EMAILS = `${a}@x.io`;
  try {
    assert.equal((await adminReportsRoute.GET(req("/api/admin/reports", { cookie, account: a }))).status, 200);
    assert.equal((await adminReportsRoute.GET(req("/api/admin/reports", { cookie }))).status, 403, "the default (b) isn't the owner");
    assert.equal((await adminReportsRoute.GET(req("/api/admin/reports", { cookie, account: b }))).status, 403);
    const act = { kind: "share", id: "nothing", action: "take_down" };
    assert.equal((await adminReportsRoute.POST(req("/api/admin/reports", json(undefined, act)))).status, 401);
    assert.equal((await adminReportsRoute.POST(req("/api/admin/reports", json(b, act)))).status, 403);
    assert.equal((await adminReportsRoute.POST(req("/api/admin/reports", json(a, act)))).status, 404, "as the owner: nobody reported it");
  } finally {
    if (admins === undefined) delete process.env.FLASH_ADMIN_EMAILS;
    else process.env.FLASH_ADMIN_EMAILS = admins;
  }
});

test("a file of any account signed in here loads, but only the tab's own account deletes one", async () => {
  const a = await account("fia");
  const b = await account("fib");
  const c = await account("fic");
  await run("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES ('file_b', ?, 'image/png', 'b.png', ?, 0)", [b, Buffer.from("png")]);
  await run("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES ('file_c', ?, 'image/png', 'c.png', ?, 0)", [c, Buffer.from("png")]);
  const { cookie } = await browser(b, a);
  const get = (id: string, account?: string, cookieOf = cookie) => fileRoute.GET(req(`/api/files/${id}`, { cookie: cookieOf, account }), ctx({ id }));
  assert.equal((await get("file_b", a)).status, 200);
  assert.equal((await get("file_b")).status, 200);
  assert.equal((await get("file_c", a)).status, 404, "not another browser's account");
  assert.equal((await get("file_b", undefined, "")).status, 401);
  const del = (account: string) => fileRoute.DELETE(req("/api/files/file_b", { method: "DELETE", cookie, account }), ctx({ id: "file_b" }));
  assert.equal((await del(a)).status, 404);
  assert.equal((await fileRoute.DELETE(req("/api/files/file_b", { method: "DELETE", cookie }), ctx({ id: "file_b" }))).status, 401);
  assert.equal(await count("SELECT COUNT(*) AS n FROM files WHERE id = 'file_b'"), 1);
  assert.equal((await del(b)).status, 200);
});

test("an app's owner looking at it isn't counted as a visitor, whichever account here is the default", async () => {
  const a = await account("pva");
  const b = await account("pvb");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('pv-b', ?, 'B', '<p>b</p>', 0, 0)", [b]);
  const views = async () => count("SELECT COALESCE(SUM(views), 0) AS n FROM site_visits WHERE site_slug = 'pv-b'");
  const look = async (cookie: string) => {
    const res = await pageRoute.GET(req("/p/pv-b", { cookie, headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0" } }), ctx({ slug: "pv-b" }));
    assert.equal(res.status, 200);
    await afterwards();
  };
  await look((await browser(b, a)).cookie);
  assert.equal(await views(), 0, "the owner, signed in here though not the default");
  await look((await browser(a)).cookie);
  assert.equal(await views(), 1);
});

test("Stripe's seller sign-up link opens for the account it was made for, and never for another", async () => {
  const a = await account("sla");
  const b = await account("slb");
  const c = await account("slc");
  await session(c);
  await run("INSERT INTO seller_accounts (user_id, stripe_account, country, currency, ready, created_at) VALUES (?, 'acct_b', 'CA', 'cad', 0, 0)", [b]);
  const saved = { key: process.env.STRIPE_SECRET_KEY, admins: process.env.FLASH_ADMIN_EMAILS, fetch: globalThis.fetch };
  process.env.STRIPE_SECRET_KEY = "rk_test";
  process.env.FLASH_ADMIN_EMAILS = `${b}@x.io`;
  const links: URLSearchParams[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/account_links") {
      links.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({ url: "https://connect.stripe.com/setup/b" });
    }
    return Response.json({ error: { message: "unexpected" } }, { status: 400 });
  }) as typeof fetch;
  try {
    const { cookie } = await browser(b, a);
    const mine = await payLinkRoute.GET(req("/api/payments/link", { cookie, as: b }));
    assert.equal(mine.status, 303);
    assert.equal(mine.headers.get("location"), "https://connect.stripe.com/setup/b");
    assert.equal(mine.headers.get("cache-control"), "no-store");
    assert.equal(links.length, 1);
    assert.equal(links[0].get("account"), "acct_b");
    assert.equal(links[0].get("refresh_url"), `${ORIGIN}/api/payments/link?as=${b}`);
    assert.equal(links[0].get("return_url"), `${ORIGIN}/?apps=1&as=${b}`);
    const other = await payLinkRoute.GET(req("/api/payments/link", { cookie, as: c }));
    assert.equal(other.status, 303);
    assert.equal(other.headers.get("location"), `${ORIGIN}/?apps=1&as=${c}`);
    assert.equal(links.length, 1, "no sign-up link for an account not signed in here");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.admins === undefined) delete process.env.FLASH_ADMIN_EMAILS;
    else process.env.FLASH_ADMIN_EMAILS = saved.admins;
  }
});

test("an app's message email opens Flash as the app's owner", async () => {
  const b = await account("emb");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('em-b', ?, 'B', '<p>b</p>', 0, 0)", [b]);
  const saved = { key: process.env.RESEND_API_KEY, fetch: globalThis.fetch };
  process.env.RESEND_API_KEY = "re_test";
  const sent: { text: string; html: string }[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as { text: string; html: string });
    return Response.json({ id: "e" });
  }) as typeof fetch;
  try {
    assert.deepEqual(await receiveMessage("em-b", { form: "contact", data: { name: "Ana" } }, "10.1.1.1", ORIGIN), { ok: true });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes(`${ORIGIN}/?apps=1&as=${b}`), sent[0].text);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.key;
  }
});

test("Open as owner binds owner mode to the tab's account's own session", async () => {
  const a = await account("oma");
  const b = await account("omb");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('om-b', ?, 'B', '<p>b</p>', 0, 0)", [b]);
  const { cookie, tokens } = await browser(b, a);
  const res = await ownerRoute.POST(req("/api/sites/om-b/owner", { cookie, account: b, json: {} }), ctx({ slug: "om-b" }));
  assert.equal(res.status, 200);
  const row = (await one<{ session_hash: string; user_id: string }>("SELECT session_hash, user_id FROM site_owner_codes WHERE site_slug = 'om-b'"))!;
  assert.deepEqual(row, { session_hash: sha256(tokens[0]), user_id: b }, "b's session, not the default's");
  assert.equal((await ownerRoute.POST(req("/api/sites/om-b/owner", { cookie, json: {} }), ctx({ slug: "om-b" }))).status, 401, "a change names the tab's account");
});

// ---------------------------------------------------------------------------------------------
// Source scans

test("only auth.ts reads the session cookie itself", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../src/", import.meta.url);
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry) || entry === "lib/server/auth.ts") continue;
    const text = await readFile(new URL(entry, root), "utf8");
    if (/readCookie\([^)]*SESSION_COOKIE|\.get\(\s*SESSION_COOKIE|["']flash_session["']/.test(text)) found.push(entry);
  }
  assert.deepEqual(found, []);
});

test("every request the pages make goes through api() or authedFetch(), which name the tab's account", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../src/components/", import.meta.url);
  // Public, signed-out, or not Flash at all (the stand-in for Google's Picker in development).
  const allowed = [/^fetch\("\/api\/status"\)/, /^fetch\("\/api\/auth\/providers"\)/, /^fetch\(`\$\{access\.mock\}\//];
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const text = await readFile(new URL(entry, root), "utf8");
    for (const m of text.matchAll(/(?<![\w.])fetch\(/g)) {
      const call = text.slice(m.index, m.index + 80);
      if (!allowed.some((a) => a.test(call))) found.push(`${entry}: ${call.split("\n")[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

test("every link to Flash's API on a page names the tab's account (withAccount)", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../src/components/", import.meta.url);
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const text = await readFile(new URL(entry, root), "utf8");
    // Starting a sign-in acts as no account yet.
    for (const m of text.matchAll(/href=(?:"\/api\/|\{`\/api\/)(?!auth\/oauth\/)/g)) found.push(`${entry}: ${text.slice(m.index, m.index + 60)}`);
  }
  assert.deepEqual(found, []);
});
