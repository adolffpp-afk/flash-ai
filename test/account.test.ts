import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_DEMO_EMAILS = "true";
delete process.env.RESEND_API_KEY;
const { emailKey, sendVerification, sendReset, redeemToken, isVerified, markVerified } = await import(
  "../src/lib/server/account.ts"
);
const { overLimit, clearLimit } = await import("../src/lib/server/limits.ts");
const { balance, ensureMonthlyCredits } = await import("../src/lib/server/credits.ts");
const { run, one } = await import("../src/lib/server/db.ts");

test("one inbox maps to one email key", () => {
  assert.equal(emailKey("Ada.Lovelace+flash@Gmail.com"), "adalovelace@gmail.com");
  assert.equal(emailKey("adalovelace@googlemail.com"), "adalovelace@gmail.com");
  assert.equal(emailKey("ada.l+x@company.io"), "ada.l@company.io");
});

test("the limiter allows max attempts per window, then blocks", async () => {
  for (let i = 0; i < 3; i++) assert.equal(await overLimit("t:1", 3, 60_000), false);
  assert.equal(await overLimit("t:1", 3, 60_000), true);
  await clearLimit("t:1");
  assert.equal(await overLimit("t:1", 3, 60_000), false);
});

test("free credits wait for a confirmed email; links work once", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@b.io', 'x', 0)");
  await ensureMonthlyCredits("u1");
  assert.equal(await balance("u1"), 0, "no free credits before confirming");
  const user = (await one<{ verified_at: number }>("SELECT verified_at FROM users WHERE id = 'u1'"))!;
  assert.equal(isVerified(user), false);

  const link = (await sendVerification({ id: "u1", email: "a@b.io" }, "http://x"))!;
  const token = new URL(link).searchParams.get("token")!;
  assert.equal(await redeemToken(token, "reset"), null, "a verify link can't reset a password");
  assert.equal(await redeemToken(token, "verify"), "u1");
  assert.equal(await redeemToken(token, "verify"), null, "links work once");
  await markVerified("u1");
  await ensureMonthlyCredits("u1");
  assert.equal(await balance("u1"), 200);

  // Asking again replaces the older reset link.
  const first = new URL((await sendReset({ id: "u1", email: "a@b.io" }, "http://x"))!).searchParams.get("token")!;
  const second = new URL((await sendReset({ id: "u1", email: "a@b.io" }, "http://x"))!).searchParams.get("token")!;
  assert.equal(await redeemToken(first, "reset"), null);
  assert.equal(await redeemToken(second, "reset"), "u1");
});

test("admins must have confirmed their email; links use FLASH_APP_URL when set", async () => {
  process.env.FLASH_ADMIN_EMAILS = "Owner@x.io";
  const { isAdmin, appUrl } = await import("../src/lib/server/auth.ts");
  const owner = { id: "o", email: "owner@x.io", name: "", preferences: "", created_at: 0, last_free_grant: 0, verified_at: 0 };
  assert.equal(isAdmin(owner), false, "an unconfirmed sign-up with the owner's address isn't admin");
  assert.equal(isAdmin({ ...owner, verified_at: 1 }), true);
  assert.equal(isAdmin({ ...owner, email: "other@x.io", verified_at: 1 }), false);

  const request = new Request("http://evil.example/api/auth/signup");
  delete process.env.FLASH_APP_URL;
  assert.equal(appUrl(request), "http://evil.example");
  process.env.FLASH_APP_URL = "https://flash-app.dev/";
  assert.equal(appUrl(request), "https://flash-app.dev");
  delete process.env.FLASH_APP_URL;
});
