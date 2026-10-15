import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_DEMO_EMAILS = "true";
delete process.env.RESEND_API_KEY;
const { sendVerification, confirmEmail, endAllSessions } = await import("../src/lib/server/account.ts");
const { sameSite } = await import("../src/lib/server/connector-http.ts");
const { run, one } = await import("../src/lib/server/db.ts");

const verifiedAt = async (id: string) => Number((await one<{ verified_at: number }>("SELECT verified_at FROM users WHERE id = ?", [id]))!.verified_at);

test("a confirmation link only confirms for someone signed in to that account", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('v1', 'v@b.io', 'x', 0)");
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('o1', 'o@b.io', 'x', 0)");
  const link = (await sendVerification({ id: "v1", email: "v@b.io" }, "http://x"))!;
  const token = new URL(link).searchParams.get("token")!;
  assert.equal(await confirmEmail(token, null), "sign_in");
  assert.equal(await verifiedAt("v1"), 0, "a stranger's account isn't confirmed by the inbox's owner opening the link");
  assert.equal(await confirmEmail(token, "o1"), "sign_in", "nor while signed in to another account");
  assert.equal(await confirmEmail(token, "v1"), "confirmed", "the link still works once signed in");
  assert.equal(await confirmEmail(token, "v1"), "invalid", "and only once");
  assert.ok((await verifiedAt("v1")) > 0);
});

test("signing out everywhere also ends apps connected to Flash", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('c1', 'c@b.io', 'x', 0)");
  await run("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at, created_at) VALUES ('h1', 'refresh', 'cl', 'c1', ?, 0)", [Date.now() + 1e9]);
  await run("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES ('k1', 'cl', 'c1', 'https://a/cb', 'x', ?)", [Date.now() + 1e6]);
  await endAllSessions("c1");
  assert.equal(await one("SELECT 1 FROM oauth_tokens WHERE user_id = 'c1'"), null);
  assert.equal(await one("SELECT 1 FROM oauth_codes WHERE user_id = 'c1'"), null);
});

test("the Connect to Flash answer must come from Flash's own page", () => {
  const req = (headers: Record<string, string>) => new Request("https://flash-app.dev/api/oauth/authorize", { method: "POST", headers });
  const own = "https://flash-app.dev";
  assert.equal(sameSite(own, req({ "sec-fetch-site": "same-origin" }), own), true);
  assert.equal(sameSite("null", req({}), own), false, "a published app on Flash's host sends null");
  assert.equal(sameSite(null, req({ "sec-fetch-site": "cross-site" }), own), false);
  assert.equal(sameSite("https://evil.example", req({}), own), false);
  assert.equal(sameSite(null, req({}), own), true, "no Origin and no Sec-Fetch-Site is not a browser");
});

const { askedCookie, mayUse } = await import("../src/lib/server/link-browser.ts");

test("a sign-in or reset link works at once only in the browser that asked for it", () => {
  const asked = new Request("https://flash-app.dev/api/auth/email-link/request", { headers: { "x-forwarded-proto": "https" } });
  const cookie = askedCookie("Ann@Gmail.com", asked);
  assert.match(cookie, /^flash_link_for=\w+; Path=\/api\/auth; HttpOnly; SameSite=Lax/);
  const using = (c: string) => new Request("https://flash-app.dev/api/auth/email-link", { method: "POST", headers: { cookie: c } });
  assert.equal(mayUse("ann@gmail.com", using(cookie.split(";")[0]), undefined), "ok");
  // A link someone else asked for, sent to this person: they're asked for the address first.
  assert.equal(mayUse("attacker@evil.io", using(cookie.split(";")[0]), undefined), "ask");
  assert.equal(mayUse("attacker@evil.io", using(""), undefined), "ask");
  assert.equal(mayUse("attacker@evil.io", using(""), "ann@gmail.com"), "wrong");
  // Their own link on another device: typing their address is enough.
  assert.equal(mayUse("ann@gmail.com", using(""), " A.nn+flash@gmail.com"), "ok");
});
