import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_DEMO_EMAILS = "true";
delete process.env.RESEND_API_KEY;
const oauth = await import("../src/lib/server/oauth.ts");
const { signInWithProvider, signInWithEmail, createSignInLink, redeemSignInLink, linkedProviders } = await import(
  "../src/lib/server/signin.ts"
);
const { createUser } = await import("../src/lib/server/users.ts");
const { run, one } = await import("../src/lib/server/db.ts");
const { balance } = await import("../src/lib/server/credits.ts");

const cookieValue = (header: string) => header.split(";")[0].split("=").slice(1).join("=");

test("only relative paths are allowed after signing in", () => {
  assert.equal(oauth.safeNext("/projects?x=1"), "/projects?x=1");
  for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "evil", "/a\nb"]) {
    assert.equal(oauth.safeNext(bad), "/", String(bad));
  }
});

test("PKCE challenge is the S256 of the verifier", () => {
  const s = oauth.newState("google", "/x");
  assert.ok(s.verifier.length >= 43);
  assert.equal(oauth.pkceChallenge(s.verifier), createHash("sha256").update(s.verifier).digest("base64url"));
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  const url = new URL(oauth.authorizeUrl(s, "https://www.flash-app.dev")!);
  assert.equal(url.searchParams.get("code_challenge"), oauth.pkceChallenge(s.verifier));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), s.state);
  assert.equal(url.searchParams.get("nonce"), s.nonce);
  assert.equal(url.searchParams.get("redirect_uri"), "https://www.flash-app.dev/api/auth/oauth/google/callback");
  assert.equal(url.toString().includes("gsecret"), false, "the secret never goes to the browser");
});

test("providers appear only when their client id and secret are set", () => {
  delete process.env.GITHUB_CLIENT_ID;
  process.env.GITHUB_CLIENT_SECRET = "s";
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  assert.deepEqual(oauth.enabledProviders(), ["google"]);
  process.env.GITHUB_CLIENT_ID = "hid";
  assert.deepEqual(oauth.enabledProviders(), ["google", "github"]);
});

test("the state cookie must match the provider, the returned state and still be fresh", () => {
  const s = oauth.newState("github", "/next", 1_000);
  const cookie = cookieValue(oauth.stateCookie(s, true));
  assert.ok(oauth.stateCookie(s, true).includes("HttpOnly") && oauth.stateCookie(s, true).includes("Secure"));
  assert.equal(oauth.checkState(cookie, "github", s.state, 2_000)?.verifier, s.verifier);
  assert.equal(oauth.checkState(cookie, "github", "wrong", 2_000), null, "state mismatch");
  assert.equal(oauth.checkState(cookie, "google", s.state, 2_000), null, "another provider's attempt");
  assert.equal(oauth.checkState(cookie, "github", s.state, s.expires + 1), null, "expired");
  assert.equal(oauth.checkState(null, "github", s.state, 2_000), null, "no cookie");
  assert.equal(oauth.checkState("not-json", "github", s.state, 2_000), null);
  const tampered = Buffer.from(JSON.stringify({ ...s, next: "//evil.example" })).toString("base64url");
  assert.equal(oauth.checkState(tampered, "github", s.state, 2_000)?.next, "/", "next is checked again");
});

test("ID tokens: audience, issuer, expiry and nonce are checked", () => {
  const t = 1_700_000_000_000;
  const google = { iss: "https://accounts.google.com", aud: "gid", exp: t / 1000 + 600, nonce: "n1", sub: "g-1", email: "Ada@Gmail.com", email_verified: true };
  const expect = { clientId: "gid", nonce: "n1" };
  assert.deepEqual(oauth.profileFromClaims("google", google, expect, t), {
    provider: "google",
    subject: "g-1",
    email: "ada@gmail.com",
    emailVerified: true,
    name: "",
  });
  assert.throws(() => oauth.profileFromClaims("google", { ...google, nonce: "other" }, expect, t), /nonce/);
  assert.throws(() => oauth.profileFromClaims("google", { ...google, aud: "someone-else" }, expect, t), /audience/);
  assert.throws(() => oauth.profileFromClaims("google", { ...google, iss: "https://evil.example" }, expect, t), /issuer/);
  assert.throws(() => oauth.profileFromClaims("google", { ...google, exp: t / 1000 - 3600 }, expect, t), /expired/);
  assert.equal(oauth.profileFromClaims("google", { ...google, email_verified: false }, expect, t).emailVerified, false);

  const msa = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const ms = { iss: `https://login.microsoftonline.com/${msa}/v2.0`, tid: msa, aud: "gid", exp: t / 1000 + 600, nonce: "n1", sub: "m-1", email: "a@outlook.com" };
  assert.equal(oauth.profileFromClaims("microsoft", ms, expect, t).emailVerified, true, "personal accounts are confirmed");
  const work = { ...ms, tid: "t-work", iss: "https://login.microsoftonline.com/t-work/v2.0" };
  assert.equal(oauth.profileFromClaims("microsoft", work, expect, t).emailVerified, false, "admin-typed work email");
  assert.equal(oauth.profileFromClaims("microsoft", { ...work, xms_edov: true }, expect, t).emailVerified, true);
  assert.throws(() => oauth.profileFromClaims("microsoft", { ...work, iss: `https://login.microsoftonline.com/${msa}/v2.0` }, expect, t), /issuer/);
});

const userRow = (id: string) =>
  one<{ email: string; password_hash: string; verified_at: number }>("SELECT email, password_hash, verified_at FROM users WHERE id = ?", [id]);

test("a provider-confirmed email signs in to the existing account (Gmail aliases too) and confirms it", async () => {
  const id = await createUser({ email: "ada.lovelace@gmail.com", passwordHash: "scrypt$x$y", verified: true });
  const r = await signInWithProvider({ provider: "google", subject: "g-ada", email: "adalovelace+x@gmail.com", emailVerified: true, name: "Ada" });
  assert.deepEqual(r, { ok: true, userId: id, created: false });
  assert.equal((await userRow(id))!.password_hash, "scrypt$x$y", "a confirmed account keeps its password");
  assert.deepEqual(await linkedProviders(id), ["google"]);
  // Next time the link is used directly, even if the email changed at Google.
  const again = await signInWithProvider({ provider: "google", subject: "g-ada", email: "new@else.io", emailVerified: true, name: "" });
  assert.deepEqual(again, { ok: true, userId: id, created: false });
});

test("an unconfirmed provider email never links to an existing account", async () => {
  const id = await createUser({ email: "grace@x.io", passwordHash: "scrypt$x$y" });
  const r = await signInWithProvider({ provider: "github", subject: "h-1", email: "grace@x.io", emailVerified: false, name: "" });
  assert.deepEqual(r, { ok: false, code: "unverified" });
  assert.deepEqual(await linkedProviders(id), []);
  assert.deepEqual(await signInWithProvider({ provider: "github", subject: "h-2", email: "", emailVerified: false, name: "" }), {
    ok: false,
    code: "no_email",
  });
});

test("confirming someone else's unconfirmed sign-up drops the password chosen before", async () => {
  const id = await createUser({ email: "linus@x.io", passwordHash: "scrypt$attacker$pw" });
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('s1', ?, ?)", [id, Date.now() + 60_000]);
  const r = await signInWithProvider({ provider: "microsoft", subject: "m-1", email: "linus@x.io", emailVerified: true, name: "" });
  assert.deepEqual(r, { ok: true, userId: id, created: false });
  const row = (await userRow(id))!;
  assert.equal(row.password_hash, "");
  assert.ok(Number(row.verified_at) > 0, "the provider confirmed the email");
  assert.equal(await one("SELECT 1 FROM sessions WHERE user_id = ?", [id]), null, "older sessions are ended");
  assert.equal(await balance(id), 200, "free credits arrive once confirmed");
});

test("new people get an account without a password, confirmed only when the provider confirmed it", async () => {
  const a = await signInWithProvider({ provider: "google", subject: "g-new", email: "new@x.io", emailVerified: true, name: "New" });
  assert.ok(a.ok && a.created);
  const row = (await userRow(a.ok ? a.userId : ""))!;
  assert.equal(row.password_hash, "");
  assert.ok(Number(row.verified_at) > 0);
  const b = await signInWithProvider({ provider: "microsoft", subject: "m-work", email: "boss@corp.io", emailVerified: false, name: "" });
  assert.ok(b.ok && b.created);
  assert.equal(Number((await userRow(b.ok ? b.userId : ""))!.verified_at), 0);
});

test("sign-in links work once, expire after 15 minutes, and a newer link replaces the older", async () => {
  const token = await createSignInLink("Link@X.io", "/after");
  assert.deepEqual(await redeemSignInLink(token), { email: "link@x.io", next: "/after" });
  assert.equal(await redeemSignInLink(token), null, "single use");
  assert.equal(await redeemSignInLink(""), null);

  const old = await createSignInLink("link@x.io", "/");
  const fresh = await createSignInLink("link@x.io", "/");
  assert.equal(await redeemSignInLink(old), null, "replaced by the newer link");
  await run("UPDATE sign_in_links SET expires_at = ?", [Date.now() - 1]);
  assert.equal(await redeemSignInLink(fresh), null, "expired");

  const id = await signInWithEmail("link@x.io");
  assert.ok(Number((await userRow(id))!.verified_at) > 0, "opening the link confirms the email");
  assert.equal(await signInWithEmail("link+tag@x.io"), id, "an alias of the same inbox is the same account");
});

test("a referral cookie is recorded on every way of signing up, never for the referrer's own inbox", async () => {
  const { referralCode } = await import("../src/lib/server/referrals.ts");
  const referrer = await createUser({ email: "host.person@gmail.com", passwordHash: "scrypt$x$y", verified: true });
  const code = await referralCode(referrer);
  const req = new Request("https://www.flash-app.dev/", { headers: { cookie: `a=1; flash_ref=${code}` } });
  const referredBy = async (id: string) =>
    (await one<{ referred_by: string | null }>("SELECT referred_by FROM users WHERE id = ?", [id]))!.referred_by;

  assert.equal(await referredBy(await createUser({ email: "pw@x.io", passwordHash: "scrypt$x$y", request: req })), referrer, "password");
  const oauthNew = await signInWithProvider(
    { provider: "github", subject: "h-ref", email: "gh@x.io", emailVerified: true, name: "" },
    req,
  );
  assert.ok(oauthNew.ok && oauthNew.created);
  assert.equal(await referredBy(oauthNew.ok ? oauthNew.userId : ""), referrer, "OAuth");
  assert.equal(await referredBy(await signInWithEmail("mail@x.io", req)), referrer, "email link");
  // The same Gmail inbox (dots, +tag) can't refer itself, whichever way it signs up.
  assert.equal(await referredBy(await signInWithEmail("hostperson+2@gmail.com", req)), null);
  assert.equal(await referredBy(await createUser({ email: "plain@x.io", passwordHash: "" })), null, "no cookie");
});
