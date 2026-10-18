import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createDecipheriv, createECDH, createHash, createHmac, createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/*
 * Alerts when Flash is closed (Web Push, src/lib/server/push.ts): the VAPID signature, RFC 8291's
 * encryption against its own example, dead addresses deleted, the account named in a browser shared
 * by several, alerts stopping with a sign-out, and alerts going only to known push services.
 */
register("./support/route-hooks.mjs", import.meta.url);
// Flash's word tables load as Next loads them, so the account's language can be checked here too.
register(
  "data:text/javascript," +
    encodeURIComponent(
      'export async function resolve(s, c, next) { const r = await next(s, c); return r.url.endsWith(".json") ? { ...r, importAttributes: { type: "json" } } : r; }',
    ),
);
process.env.DATABASE_URL = ":memory:";
process.env.FLASH_DEMO_EMAILS = "true";
delete process.env.RESEND_API_KEY;
console.warn = () => {};

// A key pair made the way /admin makes it: the raw public point and the private scalar, in base64url.
const { publicKey: pubObj, privateKey: privObj } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privObj.export({ format: "jwk" });
const rawPublic = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
const KEYS = { VAPID_PUBLIC_KEY: rawPublic.toString("base64url"), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: "mailto:hello@flash-app.dev" };
const setKeys = (on: boolean) => {
  for (const [name, value] of Object.entries(KEYS)) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
};
setKeys(true);

const push = await import("../src/lib/server/push.ts");
const pushRoute = await import("../src/app/api/push/route.ts");
const logoutRoute = await import("../src/app/api/auth/logout/route.ts");
const passwordRoute = await import("../src/app/api/me/password/route.ts");
const { createSession, hashPassword } = await import("../src/lib/server/auth.ts");
const { endAllSessions } = await import("../src/lib/server/account.ts");
const { run, all, one } = await import("../src/lib/server/db.ts");

const b64 = (s: string) => Buffer.from(s, "base64url");
const hmac = (key: Buffer, ...parts: Buffer[]) => parts.reduce((h, p) => h.update(p), createHmac("sha256", key)).digest();

/** What a browser does with an alert (RFC 8291, the receiving side), written apart from push.ts. */
function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096, "record size");
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, secret), Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])).subarray(0, 12);
  const sealed = body.subarray(21 + idlen);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 2, "the last record's delimiter");
  return padded.subarray(0, end).toString("utf8");
}

/** A browser: its push keys, and the subscription it would send (PushSubscription.toJSON()). */
function browser(endpoint: string) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7));
  return {
    endpoint,
    sub: { endpoint, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } },
    read: (body: Buffer) => JSON.parse(decrypt(body, ua.getPrivateKey(), auth)) as { title: string; body: string; url: string; tag: string },
  };
}

// Push services, stood in for: every POST is kept, and answered with the status set for its address.
type Sent = { url: string; headers: Headers; body: Buffer };
let sent: Sent[] = [];
const answers = new Map<string, number>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  sent.push({ url, headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array) });
  return new Response(null, { status: answers.get(url) ?? 201 });
}) as typeof fetch;

const ORIGIN = "https://www.flash-app.dev";
let users = 0;
/** A confirmed account (verified: false for one that isn't) signed in once, with its session cookie. */
async function account(email: string, options: { verified?: boolean; language?: string } = {}) {
  const id = `u${++users}`;
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at, language) VALUES (?, ?, ?, 0, ?, ?)", [
    id,
    email,
    await hashPassword("old password"),
    options.verified === false ? 0 : 1,
    options.language ?? "",
  ]);
  return { id, email, cookie: (await createSession(id, true)).split(";")[0] };
}
const signIn = async (user: { id: string }) => (await createSession(user.id, true)).split(";")[0];

const call = (method: string, cookie: string, body?: object, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/push`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
const rowsOf = (userId: string) => all<{ endpoint: string; session_hash: string; last_ok_at: number }>("SELECT * FROM push_subscriptions WHERE user_id = ?", [userId]);
const FCM = "https://fcm.googleapis.com/fcm/send/";

test("the VAPID header is a JWT signed with ES256 for the push service, with Flash's public key", async () => {
  // The checker used here, on RFC 8292's own example token and key.
  const verifies = (token: string, key: KeyObject) => {
    const [h, c, s] = token.split(".");
    return b64(s).length === 64 && verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, b64(s));
  };
  const example =
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
  const exampleKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: "DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc", y: "F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs" }, format: "jwk" });
  assert.ok(verifies(example, exampleKey), "RFC 8292's example verifies");

  const at = Date.UTC(2026, 9, 18, 8, 0, 0);
  const header = push.vapidHeader(`${FCM}abc?x=1`, at);
  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(match, header);
  const [, token, k] = match;
  assert.equal(k, KEYS.VAPID_PUBLIC_KEY);
  const [h, c] = token.split(".");
  assert.deepEqual(JSON.parse(b64(h).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(b64(c).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com", "the push service's origin, no path");
  assert.equal(claims.sub, "mailto:hello@flash-app.dev");
  assert.ok(claims.exp > at / 1000 && claims.exp <= at / 1000 + 24 * 3600, "expires within 24 hours, as push services require");
  assert.ok(verifies(token, pubObj), "signed by Flash's private key");
  assert.ok(!verifies(token, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey), "and by no other");
});

test("encryption gives RFC 8291's example exactly, and a browser can read a real alert", () => {
  const body = push.encryptPush(
    Buffer.from("When I grow up, I want to be a watermelon"),
    b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    b64("BTBZMqHH6r4Tts7J_aSIgg"),
    { salt: b64("DGv6ra1nlYgDCS1FRnbzlw"), serverPrivate: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
  );
  assert.equal(
    body.toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
  assert.equal(decrypt(body, b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), b64("BTBZMqHH6r4Tts7J_aSIgg")), "When I grow up, I want to be a watermelon");

  // Every alert has its own key pair and salt.
  const phone = browser(`${FCM}phone`);
  const one = push.encryptPush(Buffer.from("hi"), b64(phone.sub.keys.p256dh), b64(phone.sub.keys.auth));
  const two = push.encryptPush(Buffer.from("hi"), b64(phone.sub.keys.p256dh), b64(phone.sub.keys.auth));
  assert.notDeepEqual(one.subarray(0, 86), two.subarray(0, 86));
  assert.throws(() => push.encryptPush(Buffer.alloc(push.MAX_PLAINTEXT + 1), b64(phone.sub.keys.p256dh), b64(phone.sub.keys.auth)), "one record only");
});

test("only https addresses on known push services are taken or called", async () => {
  for (const ok of [
    `${FCM}e1:APA91b`,
    "https://fcm.googleapis.com/wp/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA",
    "https://web.push.apple.com/QGz",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
  ]) {
    assert.equal(push.pushEndpointOk(ok), true, ok);
  }
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/x",
    "https://fcm.googleapis.com.evil.example/fcm/send/x",
    "https://evil.example/fcm.googleapis.com",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://[::1]/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://fcm.googleapis.com./x",
    "https://a.b.notify.windows.com/x",
    "https://notify.windows.com.evil.example/x",
    "https://evilnotify.windows.com/x",
    "javascript:alert(1)",
    "file:///etc/passwd",
    `${FCM}${"x".repeat(2100)}`,
    "",
  ]) {
    assert.equal(push.pushEndpointOk(bad), false, bad);
  }

  const ana = await account("ana@example.com");
  for (const endpoint of ["https://169.254.169.254/latest", "http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com.evil.example/x"]) {
    const res = await pushRoute.POST(call("POST", ana.cookie, browser(endpoint).sub));
    assert.equal(res.status, 400, endpoint);
  }
  // Keys that aren't a point on P-256, or a secret of the wrong size, aren't taken either.
  const bad = browser(`${FCM}bad`);
  assert.equal((await pushRoute.POST(call("POST", ana.cookie, { ...bad.sub, keys: { ...bad.sub.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url") } }))).status, 400);
  assert.equal((await pushRoute.POST(call("POST", ana.cookie, { ...bad.sub, keys: { ...bad.sub.keys, auth: "AAAA" } }))).status, 400);
  assert.deepEqual(await rowsOf(ana.id), []);

  // A row that got in another way is never called: it's deleted instead.
  const [session] = await all<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id = ?", [ana.id]);
  const phone = browser(`${FCM}x`);
  await run("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, session_hash, created_at) VALUES (?, ?, ?, ?, ?, 0)", [
    "https://169.254.169.254/latest",
    ana.id,
    phone.sub.keys.p256dh,
    phone.sub.keys.auth,
    session.token_hash,
  ]);
  sent = [];
  assert.deepEqual(await push.sendPush(ana.id, { title: "Hi", body: "there" }), { rows: 1, sent: 0, gone: 1 });
  assert.deepEqual(sent, [], "no request was made");
  assert.deepEqual(await rowsOf(ana.id), []);
});

test("an alert reaches the browser that turned alerts on, and 404 or 410 deletes its address", async () => {
  const ben = await account("ben@example.com");
  const phone = browser(`${FCM}ben-phone`);
  const laptop = browser("https://updates.push.services.mozilla.com/wpush/v2/ben-laptop");
  const old = browser("https://web.push.apple.com/ben-old");
  for (const b of [phone, laptop, old]) assert.equal((await pushRoute.POST(call("POST", ben.cookie, b.sub))).status, 200);
  assert.equal((await rowsOf(ben.id)).length, 3);

  answers.set(laptop.endpoint, 410);
  answers.set(old.endpoint, 404);
  answers.set(phone.endpoint, 201);
  sent = [];
  const result = await push.sendPush(ben.id, {
    title: "Weekly research summary",
    body: `Three new competitors opened this week. ${"More detail. ".repeat(20)}`,
    url: "/?automations=a1&run=r1",
    tag: "flash-run-r1",
  });
  assert.deepEqual(result, { rows: 3, sent: 1, gone: 2 });
  const toPhone = sent.find((s) => s.url === phone.endpoint)!;
  assert.equal(toPhone.headers.get("content-encoding"), "aes128gcm");
  assert.match(toPhone.headers.get("authorization") ?? "", /^vapid t=/);
  assert.ok(Number(toPhone.headers.get("ttl")) > 0);
  const alert = phone.read(toPhone.body);
  assert.equal(alert.title, "Weekly research summary");
  assert.equal(Array.from(alert.body).length, 120, "the summary keeps 120 characters");
  assert.ok(alert.body.endsWith("…"));
  assert.equal(alert.url, `/?automations=a1&run=r1&as=${ben.id}`, "opens as this account");
  assert.equal(alert.tag, "flash-run-r1");

  const left = await rowsOf(ben.id);
  assert.deepEqual(left.map((r) => r.endpoint), [phone.endpoint], "the gone addresses were deleted");
  assert.ok(left[0].last_ok_at > 0);

  // A refusal that isn't "gone" (a busy push service) keeps the address for next time.
  answers.set(phone.endpoint, 503);
  assert.deepEqual(await push.sendPush(ben.id, { title: "x", body: "y" }), { rows: 1, sent: 0, gone: 0 });
  assert.equal((await rowsOf(ben.id)).length, 1);
  answers.delete(phone.endpoint);

  // A link that leaves Flash opens Flash's home instead.
  sent = [];
  await push.sendPush(ben.id, { title: "x", body: "y", url: "https://evil.example/?a=1" });
  assert.equal(phone.read(sent[0].body).url, `/?as=${ben.id}`);
  sent = [];
  await push.sendPush(ben.id, { title: "x", body: "y", url: "//evil.example/" });
  assert.equal(phone.read(sent[0].body).url, `/?as=${ben.id}`);
});

test("a browser signed in to several accounts names the account on its alert", async () => {
  const cara = await account("cara@example.com", { language: "fr" });
  const dev = await account("dev@example.com");
  const shared = browser(`${FCM}shared-laptop`);
  const own = browser(`${FCM}cara-phone`);
  // One browser where both turned alerts on (one sign-in after the other here, each with its own row).
  assert.equal((await pushRoute.POST(call("POST", cara.cookie, shared.sub))).status, 200);
  assert.equal((await pushRoute.POST(call("POST", dev.cookie, shared.sub))).status, 200);
  assert.equal((await pushRoute.POST(call("POST", cara.cookie, own.sub))).status, 200);

  sent = [];
  await push.sendPush(cara.id, { title: "Veille", body: "Rien de neuf" });
  const onShared = shared.read(sent.find((s) => s.url === shared.endpoint)!.body);
  const onOwn = own.read(sent.find((s) => s.url === own.endpoint)!.body);
  const fr = JSON.parse(readFileSync(new URL("../src/lib/i18n/fr.json", import.meta.url), "utf8"));
  assert.equal(onShared.body, `${fr["For {email}"].replace("{email}", "cara@example.com")}\nRien de neuf`, "named, in the account's language");
  assert.equal(onOwn.body, "Rien de neuf", "a browser only she uses doesn't name her");
  assert.equal(onShared.url, `/?as=${cara.id}`);

  // Once Dev logs out there, Cara's alert there no longer names her.
  assert.equal((await logoutRoute.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie: dev.cookie } }))).status, 200);
  sent = [];
  await push.sendPush(cara.id, { title: "Veille", body: "Rien de neuf" });
  assert.equal(shared.read(sent.find((s) => s.url === shared.endpoint)!.body).body, "Rien de neuf");
});

test("logging out deletes that sign-in's rows; endAllSessions and a password change delete them everywhere", async () => {
  const eve = await account("eve@example.com");
  const fay = await account("fay@example.com");
  const laptop = browser(`${FCM}shared`);
  const phone = browser(`${FCM}eve-phone`);
  const phoneCookie = await signIn(eve);
  await pushRoute.POST(call("POST", eve.cookie, laptop.sub));
  await pushRoute.POST(call("POST", phoneCookie, phone.sub));
  await pushRoute.POST(call("POST", fay.cookie, laptop.sub));

  // Eve logs out on the laptop: only that sign-in's row goes; her phone and Fay's row stay.
  await logoutRoute.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie: eve.cookie } }));
  assert.deepEqual((await rowsOf(eve.id)).map((r) => r.endpoint), [phone.endpoint]);
  assert.deepEqual((await rowsOf(fay.id)).map((r) => r.endpoint), [laptop.endpoint]);
  sent = [];
  await push.sendPush(eve.id, { title: "x", body: "y" });
  assert.deepEqual(sent.map((s) => s.url), [phone.endpoint], "nothing reaches the laptop she logged out of");

  // "Log out of all devices" (and password resets) end every sign-in, and every row with them.
  await endAllSessions(eve.id);
  assert.deepEqual(await rowsOf(eve.id), []);
  assert.deepEqual((await rowsOf(fay.id)).map((r) => r.endpoint), [laptop.endpoint], "someone else's alerts in the same browser stay");

  // Changing the password signs out every other device, and their alerts stop.
  const tablet = browser(`${FCM}fay-tablet`);
  const tabletCookie = await signIn(fay);
  await pushRoute.POST(call("POST", tabletCookie, tablet.sub));
  const changed = await passwordRoute.POST(
    new Request(`${ORIGIN}/api/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: fay.cookie },
      body: JSON.stringify({ current: "old password", next: "a new password" }),
    }),
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(await rowsOf(fay.id), []);
  sent = [];
  assert.equal((await push.sendPush(fay.id, { title: "x", body: "y" })).rows, 0);
  assert.deepEqual(sent, []);
});

test("a sign-in that ended by itself gets no alerts, and its rows go", async () => {
  const gus = await account("gus@example.com");
  const phone = browser(`${FCM}gus-phone`);
  await pushRoute.POST(call("POST", gus.cookie, phone.sub));
  await run("UPDATE sessions SET expires_at = 1 WHERE user_id = ?", [gus.id]);
  sent = [];
  assert.deepEqual(await push.sendPush(gus.id, { title: "x", body: "y" }), { rows: 0, sent: 0, gone: 0 });
  assert.deepEqual(sent, []);
  assert.deepEqual(await rowsOf(gus.id), []);
});

test("the route: who may turn alerts on, the switch's state, a test alert, and turning them off", async () => {
  const hal = await account("hal@example.com");
  const phone = browser(`${FCM}hal-phone`);
  const hash = createHash("sha256").update(phone.endpoint).digest("hex");
  const state = async (cookie = hal.cookie) => (await (await pushRoute.GET(new Request(`${ORIGIN}/api/push?e=${hash}`, { headers: { cookie } }))).json()) as { key: string | null; on: boolean };

  assert.equal((await pushRoute.GET(new Request(`${ORIGIN}/api/push`))).status, 401);
  assert.deepEqual(await state(), { key: KEYS.VAPID_PUBLIC_KEY, on: false });
  // Another site can't turn them on, nor an account whose email isn't confirmed.
  assert.equal((await pushRoute.POST(call("POST", hal.cookie, phone.sub, { origin: "https://evil.example" }))).status, 403);
  const ivy = await account("ivy@example.com", { verified: false });
  const refused = await pushRoute.POST(call("POST", ivy.cookie, browser(`${FCM}ivy`).sub));
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "unverified");
  assert.deepEqual(await rowsOf(ivy.id), []);

  // A test alert needs alerts on first.
  assert.equal((await pushRoute.POST(call("POST", hal.cookie, { action: "test", endpoint: phone.endpoint }))).status, 400);
  assert.equal((await pushRoute.POST(call("POST", hal.cookie, phone.sub))).status, 200);
  assert.deepEqual(await state(), { key: KEYS.VAPID_PUBLIC_KEY, on: true });
  assert.equal((await state(await signIn(hal))).on, false, "on only for the sign-in that turned it on here");
  sent = [];
  assert.equal((await pushRoute.POST(call("POST", hal.cookie, { action: "test", endpoint: phone.endpoint }))).status, 200);
  assert.equal(phone.read(sent[0].body).title, "Flash ∞ AI");

  assert.equal((await pushRoute.DELETE(call("DELETE", hal.cookie, { endpoint: phone.endpoint }))).status, 200);
  assert.deepEqual(await rowsOf(hal.id), []);
  assert.deepEqual(await state(), { key: KEYS.VAPID_PUBLIC_KEY, on: false });

  // At most 20 tries an hour.
  let last = 200;
  for (let i = 0; i < 20 && last !== 429; i++) last = (await pushRoute.POST(call("POST", hal.cookie, phone.sub))).status;
  assert.equal(last, 429);
});

test("until the three keys are set and belong together, nothing shows and nothing is sent", async () => {
  const jo = await account("jo@example.com");
  const phone = browser(`${FCM}jo-phone`);
  await pushRoute.POST(call("POST", jo.cookie, phone.sub));
  assert.equal((await rowsOf(jo.id)).length, 1);
  try {
    setKeys(false);
    assert.deepEqual(push.pushSetup(), { setUp: false, missing: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"], problem: "" });
    const shown = (await (await pushRoute.GET(new Request(`${ORIGIN}/api/push`, { headers: { cookie: jo.cookie } }))).json()) as { key: string | null };
    assert.equal(shown.key, null, "Settings hides the switch");
    assert.equal((await pushRoute.POST(call("POST", jo.cookie, browser(`${FCM}jo-2`).sub))).status, 404);
    sent = [];
    assert.deepEqual(await push.sendPush(jo.id, { title: "x", body: "y" }), { rows: 0, sent: 0, gone: 0 });
    assert.deepEqual(sent, []);

    // A private key from another pair is caught, and named without its value.
    setKeys(true);
    process.env.VAPID_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" }).d!;
    const mismatch = push.pushSetup();
    assert.equal(mismatch.setUp, false);
    assert.match(mismatch.problem, /doesn't belong to VAPID_PUBLIC_KEY/);
    assert.ok(!mismatch.problem.includes(process.env.VAPID_PRIVATE_KEY));
    assert.equal(push.pushPublicKey(), null);
    process.env.VAPID_PRIVATE_KEY = KEYS.VAPID_PRIVATE_KEY;
    process.env.VAPID_SUBJECT = "hello@flash-app.dev";
    assert.match(push.pushSetup().problem, /VAPID_SUBJECT/);
  } finally {
    setKeys(true);
  }
  assert.deepEqual(push.pushSetup(), { setUp: true, missing: [], problem: "" });
  assert.equal(push.pushPublicKey(), KEYS.VAPID_PUBLIC_KEY);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?", [jo.id]))?.n, 1, "rows wait for the keys");
});
