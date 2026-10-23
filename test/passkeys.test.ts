import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { register } from "node:module";

/*
 * Passkeys (see passkeys.ts), with a software authenticator standing in for a phone: adding one,
 * signing in with it (which skips the two-step code), and what must fail: another site's origin, a
 * challenge used twice or from another browser, a device that didn't check its lock, a copied key
 * whose counter went back, and passkeys a stranger added before the inbox's owner claimed the account.
 */
register("./support/route-hooks.mjs", import.meta.url);

process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
process.env.FLASH_APP_URL = "https://www.flash-app.dev";
process.env.RESEND_API_KEY = "re_test";
const sent: { to: string[]; subject: string }[] = [];
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return new Response("{}", { status: 200 });
}) as typeof fetch;
const pk = await import("../src/lib/server/passkeys.ts");
const tf = await import("../src/lib/server/two-factor.ts");
const { codeFor, stepAt } = await import("../src/lib/server/totp.ts");
const { all, one, run } = await import("../src/lib/server/db.ts");
const { userForSession, createSession, hashPassword } = await import("../src/lib/server/auth.ts");
const { endAllSessions } = await import("../src/lib/server/account.ts");
const route = await import("../src/app/api/auth/passkey/route.ts");
const mine = await import("../src/app/api/me/passkeys/route.ts");
const { afterwards } = await import("./support/next-server.mjs");

const ORIGIN = "https://www.flash-app.dev";
const b64 = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

// Just enough CBOR for an attestation object and a COSE key.
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("unsupported");
}

/** A phone's passkey for www.flash-app.dev: its key pair, credential ID and use counter. */
function device() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKey, id: randomBytes(16), counter: 0 };
}
type Device = ReturnType<typeof device>;

const flags = (uv: boolean, attested = false) => 0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0);
const counterBytes = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const clientData = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }));

function created(d: Device, challenge: string, o: { origin?: string; uv?: boolean; rpId?: string } = {}) {
  const jwk = (d.publicKey as KeyObject).export({ format: "jwk" });
  const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const authData = Buffer.concat([
    sha(o.rpId ?? "www.flash-app.dev"),
    Buffer.from([flags(o.uv ?? true, true)]),
    counterBytes(d.counter),
    Buffer.from("fbfc3007154e4ecc8c0b6e020557d7bd", "hex"),
    Buffer.from([0, d.id.length]),
    d.id,
    cose,
  ]);
  const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  return {
    id: b64(d.id),
    rawId: b64(d.id),
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: b64(clientData("webauthn.create", challenge, o.origin)), attestationObject: b64(attestationObject), transports: ["internal", "hybrid"] },
  };
}

function signed(d: Device, challenge: string, o: { origin?: string; uv?: boolean; counter?: number } = {}) {
  const count = o.counter ?? ++d.counter;
  const authData = Buffer.concat([sha("www.flash-app.dev"), Buffer.from([flags(o.uv ?? true)]), counterBytes(count)]);
  const cd = clientData("webauthn.get", challenge, o.origin);
  return {
    id: b64(d.id),
    rawId: b64(d.id),
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: b64(cd), authenticatorData: b64(authData), signature: b64(sign("sha256", Buffer.concat([authData, sha(cd)]), d.privateKey)) },
  };
}

const cookieOf = (setCookie: string) => setCookie.split(";")[0];
const req = (cookie = "") => new Request(`${ORIGIN}/api/me/passkeys`, { method: "POST", headers: { cookie } });
const user = { id: "p1", email: "pat@b.io", name: "Pat" };

test("a passkey is added with the device's lock checked, and only its public key is kept", async () => {
  await run("INSERT INTO users (id, email, password_hash, verified_at, created_at) VALUES ('p1', 'pat@b.io', 'x', 1, 0)");
  const d = device();
  const { options, cookie } = await pk.addOptions(user, req());
  assert.equal(options.rp.id, "www.flash-app.dev", "never the bare domain, which other subdomains share");
  assert.equal(options.authenticatorSelection?.userVerification, "required");
  assert.equal(options.authenticatorSelection?.residentKey, "required");
  assert.match(cookie, /^flash_passkey=.*Path=\/api; HttpOnly; SameSite=Strict/);

  assert.deepEqual(await pk.addPasskey("p1", req(), created(d, options.challenge) as never), { ok: false, reason: "expired" }, "not from a browser without the challenge");
  const added = await pk.addPasskey("p1", req(cookieOf(cookie)), created(d, options.challenge) as never);
  assert.ok(added.ok);
  assert.equal(added.ok && added.passkey.name, "iCloud Keychain");
  assert.deepEqual(await pk.addPasskey("p1", req(cookieOf(cookie)), created(d, options.challenge) as never), { ok: false, reason: "expired" }, "a challenge works once");

  const row = await one<{ public_key: string; transports: string }>("SELECT public_key, transports FROM passkeys WHERE id = ?", [b64(d.id)]);
  assert.ok(row!.public_key.length > 40);
  assert.equal(row!.transports, "internal,hybrid");
  const again = await pk.addOptions(user, req());
  assert.deepEqual(again.options.excludeCredentials?.map((c) => c.id), [b64(d.id)], "the device isn't asked to make a second one");
});

test("adding fails from another site, without the lock, or for another account's challenge", async () => {
  for (const o of [{ origin: "https://shop.flash-app.dev" }, { uv: false }, { rpId: "flash-app.dev" }]) {
    const { options, cookie } = await pk.addOptions(user, req());
    assert.deepEqual(await pk.addPasskey("p1", req(cookieOf(cookie)), created(device(), options.challenge, o) as never), { ok: false, reason: "failed" }, JSON.stringify(o));
  }
  const { options, cookie } = await pk.addOptions(user, req());
  assert.deepEqual(await pk.addPasskey("someone-else", req(cookieOf(cookie)), created(device(), options.challenge) as never), { ok: false, reason: "expired" });
});

const post = (json: unknown, cookie = "") =>
  route.POST(
    new Request(`${ORIGIN}/api/auth/passkey`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify(json),
    }),
  );
const setCookies = (res: Response) => res.headers.getSetCookie();

test("signing in with a passkey skips the two-step code, and a used or copied one doesn't work", async () => {
  await run("INSERT INTO users (id, email, password_hash, verified_at, created_at) VALUES ('p2', 'sam@b.io', 'x', 1, 0)");
  const d = device();
  const add = await pk.addOptions({ id: "p2", email: "sam@b.io" }, req());
  assert.ok((await pk.addPasskey("p2", req(cookieOf(add.cookie)), created(d, add.options.challenge) as never)).ok);
  // Two-step sign-in is on: a password alone would only get to the code page.
  const setup = (await tf.startSetup({ id: "p2", email: "sam@b.io" }))!;
  assert.ok((await tf.enableTwoFactor("p2", codeFor(setup.secret, stepAt(Date.now()) - 1))).ok);

  const start = await post({ step: "options" });
  const { options } = (await start.json()) as { options: { challenge: string; allowCredentials?: unknown[]; rpId: string } };
  assert.deepEqual(options.allowCredentials ?? [], [], "no account named, so nobody learns which emails have one");
  const challengeCookie = cookieOf(setCookies(start)[0]);

  const done = await post({ step: "verify", response: signed(d, options.challenge) }, challengeCookie);
  assert.equal(done.status, 200);
  const session = setCookies(done).find((c) => c.startsWith("flash_session="))!;
  assert.equal((await userForSession(cookieOf(session).split("=")[1]))?.id, "p2", "signed in, no code page");
  assert.ok(setCookies(done).some((c) => c.startsWith("flash_device=")), "the browser is noted for new-device emails");
  const logged = await all<{ method: string }>("SELECT method FROM sign_ins WHERE user_id = 'p2'");
  assert.deepEqual(logged.map((r) => r.method), ["passkey"]);

  const replay = await post({ step: "verify", response: signed(d, options.challenge) }, challengeCookie);
  assert.equal(replay.status, 400, "a challenge works once");

  const next = (await (await post({ step: "options" })).json()) as { options: { challenge: string } };
  const n = await post({ step: "options" });
  const nCookie = cookieOf(setCookies(n)[0]);
  const nOptions = ((await n.json()) as { options: { challenge: string } }).options;
  assert.equal((await post({ step: "verify", response: signed(d, next.options.challenge) }, nCookie)).status, 400, "another browser's challenge");
  assert.equal((await post({ step: "verify", response: signed(d, nOptions.challenge, { counter: 1 }) }, nCookie)).status, 400, "a counter gone back: a copied key");

  const w = await post({ step: "options" });
  const wOptions = ((await w.json()) as { options: { challenge: string } }).options;
  assert.equal((await post({ step: "verify", response: signed(d, wOptions.challenge, { origin: "https://evil.example" }) }, cookieOf(setCookies(w)[0]))).status, 400, "another site");
  const u = await post({ step: "options" });
  const uOptions = ((await u.json()) as { options: { challenge: string } }).options;
  assert.equal((await post({ step: "verify", response: signed(d, uOptions.challenge, { uv: false }) }, cookieOf(setCookies(u)[0]))).status, 400, "the device's lock wasn't checked");
});

test("a removed passkey no longer opens the account", async () => {
  const d = device();
  const add = await pk.addOptions(user, req());
  assert.ok((await pk.addPasskey("p1", req(cookieOf(add.cookie)), created(d, add.options.challenge) as never)).ok);
  assert.equal((await pk.listPasskeys("p1")).length, 2);
  assert.equal(await pk.removePasskey("p2", b64(d.id)), null, "only its own account can remove it");
  assert.equal(await pk.removePasskey("p1", b64(d.id)), "iCloud Keychain");
  const s = await post({ step: "options" });
  const o = ((await s.json()) as { options: { challenge: string } }).options;
  assert.equal((await post({ step: "verify", response: signed(d, o.challenge) }, cookieOf(setCookies(s)[0]))).status, 400);
});

test("a sign-in from another site's page is refused", async () => {
  const res = await route.POST(
    new Request(`${ORIGIN}/api/auth/passkey`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ step: "options" }),
    }),
  );
  assert.equal(res.status, 403);
});

const settings = (json: unknown, cookie: string) =>
  mine.POST(
    new Request(`${ORIGIN}/api/me/passkeys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify(json),
    }),
  );

test("an old session can't add a passkey without the password; a fresh one can, and each change is emailed", async () => {
  await run("INSERT INTO users (id, email, password_hash, verified_at, created_at) VALUES ('p3', 'kim@b.io', ?, 1, 0)", [await hashPassword("right horse battery")]);
  const session = cookieOf(await createSession("p3", true));
  await run("UPDATE sessions SET created_at = 0 WHERE user_id = 'p3'");

  const asked = await settings({ action: "options" }, session);
  assert.equal(asked.status, 403);
  assert.deepEqual(await asked.json().then((b) => [b.code, b.password, b.twoFactor]), ["reauth", true, false]);
  assert.equal((await settings({ action: "options", password: "wrong" }, session)).status, 400);
  const ok = await settings({ action: "options", password: "right horse battery" }, session);
  assert.equal(ok.status, 200);

  const d = device();
  const { options } = (await ok.json()) as { options: { challenge: string } };
  const before = sent.length;
  const added = await settings({ action: "add", response: created(d, options.challenge) }, `${session}; ${cookieOf(ok.headers.getSetCookie()[0])}`);
  assert.equal(added.status, 200);
  await afterwards();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1)!.to, ["kim@b.io"]);
  assert.equal(sent.at(-1)!.subject, "A passkey was added to your Flash ∞ AI account");

  assert.equal((await settings({ action: "remove", id: b64(d.id) }, session)).status, 200);
  await afterwards();
  assert.equal(sent.at(-1)!.subject, "A passkey was removed from your Flash ∞ AI account");

  // A sign-in from the last 15 minutes needs nothing more.
  const fresh = cookieOf(await createSession("p3", true));
  assert.equal((await settings({ action: "options" }, fresh)).status, 200);
});

test("logging out everywhere (and so a password reset) removes the account's passkeys, and a gone account's passkey opens nothing", async () => {
  const d = device();
  const add = await pk.addOptions({ id: "p3", email: "kim@b.io" }, req());
  assert.ok((await pk.addPasskey("p3", req(cookieOf(add.cookie)), created(d, add.options.challenge) as never)).ok);
  await endAllSessions("p3");
  assert.deepEqual(await pk.listPasskeys("p3"), []);

  const e = device();
  const again = await pk.addOptions({ id: "p3", email: "kim@b.io" }, req());
  assert.ok((await pk.addPasskey("p3", req(cookieOf(again.cookie)), created(e, again.options.challenge) as never)).ok);
  await run("DELETE FROM users WHERE id = 'p3'");
  const s = await post({ step: "options" });
  const o = ((await s.json()) as { options: { challenge: string } }).options;
  assert.equal((await post({ step: "verify", response: signed(e, o.challenge) }, cookieOf(setCookies(s)[0]))).status, 400);
});
