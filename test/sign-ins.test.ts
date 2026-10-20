import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { register } from "node:module";

/*
 * The sign-in log on the owner dashboard (see sign-ins.ts): a finished sign-in is noted with how it
 * was done and the country only, a two-step sign-in once its code is typed, and only the owner can
 * read the log and its counts.
 */
register("./support/route-hooks.mjs", import.meta.url);

process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
process.env.FLASH_ADMIN_EMAILS = "owner@b.io";
const tf = await import("../src/lib/server/two-factor.ts");
const { codeFor, stepAt } = await import("../src/lib/server/totp.ts");
const { all, run } = await import("../src/lib/server/db.ts");
const { signInCounts, signInLog, LOG_PAGE } = await import("../src/lib/server/sign-ins.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const route = await import("../src/app/api/admin/sign-ins/route.ts");

const req = (cookie = "", headers: Record<string, string> = {}) =>
  new Request("https://flash-app.dev/api/auth/two-factor", { method: "POST", headers: { cookie, ...headers } });
const logged = () => all<{ user_id: string; method: string; country: string }>("SELECT user_id, method, country FROM sign_ins ORDER BY id");

test("a sign-in is noted with its method and country, and nothing about the device", async () => {
  await run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('s1', 'ann@b.io', 'Ann', 'x', ?)", [Date.now()]);
  await tf.signInCookie("s1", req("", { "x-vercel-ip-country": "ca", "x-forwarded-for": "1.2.3.4" }), "/", "google");
  await tf.signInCookie("s1", req("", { "x-vercel-ip-country": "not a country" }), "/", "email_link");
  assert.deepEqual(
    (await logged()).map((r) => ({ ...r })),
    [
      { user_id: "s1", method: "google", country: "CA" },
      { user_id: "s1", method: "email_link", country: "" },
    ],
  );
  const columns = (await all<{ name: string }>("PRAGMA table_info(sign_ins)")).map((c) => c.name);
  assert.deepEqual(columns, ["id", "user_id", "method", "country", "created_at"]);
});

test("with two-step sign-in on, it's noted once the code is typed, with the method it began with", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('s2', 'bo@b.io', 'x', 0)");
  const setup = (await tf.startSetup({ id: "s2", email: "bo@b.io" }))!;
  const at = Date.now();
  assert.ok((await tf.enableTwoFactor("s2", codeFor(setup.secret, stepAt(at) - 1))).ok);
  const before = (await logged()).length;
  const pending = await tf.signInCookie("s2", req(), "/", "github");
  assert.equal(pending.twoFactor, true);
  assert.equal((await logged()).length, before, "not signed in yet");
  const c = pending.cookie.split(";")[0];
  assert.deepEqual(await tf.finishSignIn(req(c), "000000"), { ok: false, reason: "wrong" });
  assert.equal((await logged()).length, before, "a wrong code isn't a sign-in");
  assert.ok((await tf.finishSignIn(req(c), codeFor(setup.secret, stepAt(at)))).ok);
  assert.deepEqual({ ...(await logged()).at(-1) }, { user_id: "s2", method: "github", country: "" });
});

test("the log is newest first, searchable, in pages; counts are of different people", async () => {
  const first = await signInLog();
  assert.equal(first.rows[0].email, "bo@b.io");
  assert.deepEqual(
    (await signInLog("ANN")).rows.map((r) => [r.name, r.method]),
    [
      ["Ann", "email_link"],
      ["Ann", "google"],
    ],
  );
  assert.equal((await signInLog("%")).rows.length, 0, "a % is searched for, not a wildcard");

  for (let i = 0; i < LOG_PAGE + 5; i++) await run("INSERT INTO sign_ins (user_id, method, created_at) VALUES ('s1', 'password', ?)", [Date.now()]);
  const page = await signInLog();
  assert.equal(page.rows.length, LOG_PAGE);
  assert.ok(page.more);
  const next = await signInLog("", page.rows.at(-1)!.id);
  assert.equal(next.more, false);
  assert.equal(page.rows.length + next.rows.length, LOG_PAGE + 5 + 3);

  const counts = await signInCounts();
  assert.deepEqual(counts.signedIn, { today: 2, week: 2, month: 2 });
  assert.deepEqual(counts.new, { today: 1, week: 1, month: 1 }, "s2 was made long ago");
  assert.equal(counts.users, 2);
  assert.equal(counts.series.length, 30);
  assert.equal(counts.series.at(-1)!.signedIn, 2);
});

test("only the owner can read it", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('o1', 'owner@b.io', 'x', 0, 1)");
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('o2', 'other@b.io', 'x', 0, 1)");
  const get = async (userId: string) => {
    const cookie = (await createSession(userId, true)).split(";")[0];
    return route.GET(new Request("https://flash-app.dev/api/admin/sign-ins?q=ann", { headers: { cookie } }));
  };
  assert.equal((await get("o2")).status, 403);
  const res = await get("o1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { counts: unknown; log: { rows: { email: string }[] } };
  assert.ok(body.counts);
  assert.ok(body.log.rows.every((r) => r.email === "ann@b.io"));
  assert.equal((await route.GET(new Request("https://flash-app.dev/api/admin/sign-ins"))).status, 401);
});
