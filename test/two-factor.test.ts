import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
const { base32, checkCode, codeFor, fromBase32, otpauthUri, stepAt } = await import("../src/lib/server/totp.ts");
const tf = await import("../src/lib/server/two-factor.ts");
const { run, one } = await import("../src/lib/server/db.ts");
const { userForSession } = await import("../src/lib/server/auth.ts");

test("codes match RFC 6238's SHA-1 test values", () => {
  // The RFC's secret is the ASCII "12345678901234567890"; its 8-digit codes end in these 6 digits.
  const secret = base32(Buffer.from("12345678901234567890"));
  assert.equal(fromBase32(secret).toString(), "12345678901234567890");
  assert.equal(codeFor(secret, stepAt(59_000)), "287082");
  assert.equal(codeFor(secret, stepAt(1111111109_000)), "081804");
  assert.equal(codeFor(secret, stepAt(2000000000_000)), "279037");
});

test("a code works for its step and the ones beside it, once, and nothing else does", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  const t = 1111111109_000;
  const step = stepAt(t);
  assert.equal(checkCode(secret, codeFor(secret, step), t), step);
  assert.equal(checkCode(secret, codeFor(secret, step - 1), t), step - 1, "a phone clock a little behind");
  assert.equal(checkCode(secret, codeFor(secret, step + 2), t), null, "too far ahead");
  assert.equal(checkCode(secret, codeFor(secret, step), t, step), null, "already used");
  assert.equal(checkCode(secret, "12345", t), null);
  assert.equal(checkCode(secret, "abcdef", t), null);
  assert.match(otpauthUri(secret, "a@b.io"), /^otpauth:\/\/totp\/Flash%20AI%3Aa%40b\.io\?secret=/);
});

const cookieValue = (setCookie: string) => setCookie.split(";")[0];
const req = (cookie = "") => new Request("https://flash-app.dev/api/auth/two-factor", { method: "POST", headers: { cookie } });

test("with two-step sign-in on, a password alone doesn't sign in; the code does, once", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('t1', 't@b.io', 'x', 0)");
  const off = await tf.signInCookie("t1", req());
  assert.equal(off.twoFactor, false);
  assert.match(off.cookie, /^flash_session=/);

  const setup = (await tf.startSetup({ id: "t1", email: "t@b.io" }))!;
  assert.equal(await tf.twoFactorOn("t1"), false, "not on until the first code");
  assert.deepEqual(await tf.enableTwoFactor("t1", "000000").then((r) => r.ok), false);
  // The sign-in below needs a later step than the one used to turn it on, as in real life.
  const now = Date.now();
  const enabled = await tf.enableTwoFactor("t1", codeFor(setup.secret, stepAt(now) - 1));
  assert.ok(enabled.ok);
  const codes = enabled.ok ? enabled.codes : [];
  assert.equal(codes.length, 10);
  assert.equal(await tf.startSetup({ id: "t1", email: "t@b.io" }), null, "can't be replaced while on");

  const pending = await tf.signInCookie("t1", req(), "/next");
  assert.equal(pending.twoFactor, true);
  assert.match(pending.cookie, /^flash_2fa=.*Path=\/api\/auth; HttpOnly/);
  const c = cookieValue(pending.cookie);
  assert.equal(await userForSession(c.split("=")[1]), null, "the waiting cookie is no session");

  assert.deepEqual(await tf.finishSignIn(req(c), "111111"), { ok: false, reason: "wrong" });
  const done = await tf.finishSignIn(req(c), codeFor(setup.secret, stepAt(now)));
  assert.ok(done.ok);
  if (done.ok) {
    assert.equal(done.next, "/next");
    assert.equal((await userForSession(cookieValue(done.cookie).split("=")[1]))?.id, "t1");
  }
  assert.deepEqual(await tf.finishSignIn(req(c), codeFor(setup.secret, stepAt(now))), { ok: false, reason: "expired" }, "the waiting sign-in is used up");

  // The same app code can't be used again; a recovery code works once.
  const again = cookieValue((await tf.signInCookie("t1", req())).cookie);
  assert.deepEqual(await tf.finishSignIn(req(again), codeFor(setup.secret, stepAt(now))), { ok: false, reason: "wrong" });
  assert.ok((await tf.finishSignIn(req(again), codes[0].toUpperCase())).ok);
  const third = cookieValue((await tf.signInCookie("t1", req())).cookie);
  assert.deepEqual(await tf.finishSignIn(req(third), codes[0]), { ok: false, reason: "wrong" });
  assert.equal(await tf.recoveryLeft("t1"), 9);
});

test("a waiting sign-in allows five tries, then has to start over", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('t2', 'u@b.io', 'x', 0)");
  const setup = (await tf.startSetup({ id: "t2", email: "u@b.io" }))!;
  assert.ok((await tf.enableTwoFactor("t2", codeFor(setup.secret, stepAt(Date.now()) - 1))).ok);
  const c = cookieValue((await tf.signInCookie("t2", req())).cookie);
  for (let i = 0; i < 5; i++) assert.equal((await tf.finishSignIn(req(c), "000000").then((r) => !r.ok && r.reason)), "wrong");
  assert.deepEqual(await tf.finishSignIn(req(c), codeFor(setup.secret, stepAt(Date.now()))), { ok: false, reason: "expired" });
});

test("turning it off needs a code, and the secret is stored sealed", async () => {
  const row = await one<{ enc_secret: string }>("SELECT enc_secret FROM two_factor WHERE user_id = 't2'");
  assert.match(row!.enc_secret, /^v1:/);
  assert.deepEqual(await tf.disableTwoFactor("t2", "123456"), { ok: false, reason: "wrong" });
  const codes = await tf.renewRecoveryCodes("t2", "000000");
  assert.equal(codes.ok, false);
});
