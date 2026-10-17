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
  assert.equal(((await got.json()) as { user: { id: string } }).user.id, a);
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
