import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * New-device sign-in emails (see new-device.ts): an account's first browser is noted quietly, the
 * same browser again sends nothing, a browser it never used sends one email that says how and from
 * where (and no more than three an hour), and a new account's own browser counts as its first.
 */
process.env.DATABASE_URL = ":memory:";
process.env.RESEND_API_KEY = "re_test";
const sent: { to: string[]; subject: string; text: string }[] = [];
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return new Response("{}", { status: 200 });
}) as typeof fetch;
const { noteDevice, DEVICE_COOKIE } = await import("../src/lib/server/new-device.ts");
const { run } = await import("../src/lib/server/db.ts");

const req = (cookie = "", country = "") =>
  new Request("https://www.flash-app.dev/api/auth/login", { headers: { cookie, ...(country && { "x-vercel-ip-country": country }) } });
const cookieOf = (c: string[]) => c[0].split(";")[0];

test("a browser the account never used is emailed, the first and the same one aren't", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('d1', 'dee@b.io', 'x', 0)");
  const first = await noteDevice("d1", req(), "password");
  assert.match(first[0], new RegExp(`^${DEVICE_COOKIE}=[A-Za-z0-9_-]{32}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure`));
  assert.equal(sent.length, 0, "the browser they already use isn't news");
  await noteDevice("d1", req(cookieOf(first)), "google");
  assert.equal(sent.length, 0);

  const other = await noteDevice("d1", req("", "FR"), "email_link");
  assert.notEqual(cookieOf(other), cookieOf(first));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["dee@b.io"]);
  assert.equal(sent[0].subject, "New sign-in to your Flash ∞ AI account");
  assert.match(sent[0].text, /with an email sign-in link from France, on /);
  assert.match(sent[0].text, /Log out of all devices/);
  await noteDevice("d1", req(cookieOf(other)), "password");
  assert.equal(sent.length, 1, "known now");
});

test("at most three emails an hour, and a new account's browser is its first", async () => {
  for (let i = 0; i < 5; i++) await noteDevice("d1", req(), "password");
  assert.equal(sent.length, 3, "the one before and two more");

  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('d2', 'new@b.io', 'x', 0)");
  const made = await noteDevice("d2", req(), "sign_up");
  await noteDevice("d2", req(cookieOf(made)), "password");
  assert.equal(sent.length, 3);
  await noteDevice("d2", req("flash_device=not!valid"), "password");
  assert.equal(sent.length, 4, "a cookie that isn't Flash's counts as a new browser");
});
