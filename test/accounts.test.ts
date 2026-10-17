import { test } from "node:test";
import assert from "node:assert/strict";
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

const auth = await import("../src/lib/server/auth.ts");
const { all, one, run } = await import("../src/lib/server/db.ts");
const { randomId, sha256 } = await import("../src/lib/server/ids.ts");
const meRoute = await import("../src/app/api/me/route.ts");
const projectRoute = await import("../src/app/api/projects/[id]/route.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");

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

type Req = { method?: string; cookie?: string; account?: string; as?: string; json?: unknown; body?: BodyInit; origin?: string | null; site?: string; headers?: Record<string, string>; base?: string };
/** A request as Flash's page sends it: JSON from its own origin, naming the tab's account when given. */
function req(path: string, o: Req = {}): Request {
  const headers: Record<string, string> = { ...o.headers };
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
