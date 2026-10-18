import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createDecipheriv, createECDH, createHash, createHmac, createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/*
 * Alerts when Flash is closed (Web Push, src/lib/server/push.ts): the VAPID signature, RFC 8291's
 * encryption against its own example, dead addresses deleted, a busy push service tried twice, the
 * account named in a browser shared by several, alerts stopping with a sign-out or a sign-in on top,
 * alerts going only to known push services, and the service worker (public/sw.js): an alert's words
 * shown only while that sign-in is live, tags, and where a tap goes.
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
const loginRoute = await import("../src/app/api/auth/login/route.ts");
const linkRoute = await import("../src/app/api/auth/email-link/route.ts");
const signupRoute = await import("../src/app/api/auth/signup/route.ts");
const { createSignInLink } = await import("../src/lib/server/signin.ts");
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
    // The alert as the browser gives it to the service worker, and read.
    open: (body: Buffer) => decrypt(body, ua.getPrivateKey(), auth),
    read: (body: Buffer) => JSON.parse(decrypt(body, ua.getPrivateKey(), auth)) as { title: string; body: string; url: string; tag?: string },
  };
}

// Push services, stood in for: every POST is kept, and answered with what's set for its address (201
// by default): a status, a status with headers, or an error for a lost connection. A list is answered
// in turn, its last answer staying.
type Sent = { url: string; headers: Headers; body: Buffer };
type Answer = number | Error | { status: number; headers: Record<string, string> };
let sent: Sent[] = [];
const answers = new Map<string, Answer | Answer[]>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  sent.push({ url, headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array) });
  const set = answers.get(url) ?? 201;
  const answer = Array.isArray(set) ? (set.length > 1 ? set.shift()! : set[0]) : set;
  if (answer instanceof Error) throw answer;
  return typeof answer === "number" ? new Response(null, { status: answer }) : new Response(null, answer);
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
  // Each browser with its own sign-in.
  for (const b of [phone, laptop, old]) assert.equal((await pushRoute.POST(call("POST", await signIn(ben), b.sub))).status, 200);
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

  // A refusal that isn't "gone" (a busy push service, twice) keeps the address for next time.
  answers.set(phone.endpoint, 503);
  assert.deepEqual(await push.sendPush(ben.id, { title: "x", body: "y" }), { rows: 1, sent: 0, gone: 0 });
  assert.equal((await rowsOf(ben.id)).length, 1);
  answers.delete(phone.endpoint);

  // A page address too long for one alert opens Flash's home, and the alert still goes.
  sent = [];
  assert.deepEqual(await push.sendPush(ben.id, { title: "x", body: "y", url: `/?automations=a1&q=${"x".repeat(4000)}` }), { rows: 1, sent: 1, gone: 0 });
  assert.equal(phone.read(sent[0].body).url, `/?as=${ben.id}`);
  assert.deepEqual((await rowsOf(ben.id)).map((r) => r.endpoint), [phone.endpoint]);

  // A link that leaves Flash opens Flash's home instead.
  sent = [];
  await push.sendPush(ben.id, { title: "x", body: "y", url: "https://evil.example/?a=1" });
  assert.equal(phone.read(sent[0].body).url, `/?as=${ben.id}`);
  sent = [];
  await push.sendPush(ben.id, { title: "x", body: "y", url: "//evil.example/" });
  assert.equal(phone.read(sent[0].body).url, `/?as=${ben.id}`);
});

test("a title or summary that's cut never splits a character, like a flag or a family emoji", async () => {
  const zoe = await account("zoe.clip@example.com");
  const phone = browser(`${FCM}zoe-clip`);
  await pushRoute.POST(call("POST", zoe.cookie, phone.sub));
  const shown = async (title: string, body: string) => {
    sent = [];
    await push.sendPush(zoe.id, { title, body });
    return phone.read(sent[0].body);
  };
  // The 80th character of the name is the first half of a flag (two code points), and the 119th of
  // the summary starts a family (man, joiner, woman, joiner, girl): each goes whole.
  let alert = await shown(`${"a".repeat(78)}🇫🇷 trip`, `${"b".repeat(118)}👨‍👩‍👧 booked`);
  assert.equal(alert.title, `${"a".repeat(78)}…`);
  assert.equal(alert.body, `${"b".repeat(118)}…`);
  // Whole ones before the cut stay.
  alert = await shown(`${"a".repeat(77)}🇫🇷 trip to Paris`, `${"b".repeat(114)}👨‍👩‍👧 booked`);
  assert.equal(alert.title, `${"a".repeat(77)}🇫🇷…`);
  assert.equal(alert.body, `${"b".repeat(114)}👨‍👩‍👧…`);
  // Joined emoji count every code point toward the limit, so an alert always fits in one record.
  alert = await shown("👨‍👩‍👧".repeat(40), "👍🏽".repeat(100));
  assert.equal(alert.title, `${"👨‍👩‍👧".repeat(15)}…`);
  assert.equal(alert.body, `${"👍🏽".repeat(59)}…`);
});

test("a browser signed in to several accounts names the account on its alert", async () => {
  const cara = await account("cara@example.com", { language: "fr" });
  const dev = await account("dev@example.com");
  const shared = browser(`${FCM}shared-laptop`);
  const own = browser(`${FCM}cara-phone`);
  // One browser where both turned alerts on (one sign-in after the other here, each with its own row).
  assert.equal((await pushRoute.POST(call("POST", cara.cookie, shared.sub))).status, 200);
  assert.equal((await pushRoute.POST(call("POST", dev.cookie, shared.sub))).status, 200);
  assert.equal((await pushRoute.POST(call("POST", await signIn(cara), own.sub))).status, 200);

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

test("a busy push service or a lost connection gets one more try, and a 4xx none", async () => {
  const max = await account("max@example.com");
  const phone = browser(`${FCM}max-phone`);
  await pushRoute.POST(call("POST", max.cookie, phone.sub));
  const tries = async (answer: Answer[]) => {
    answers.set(phone.endpoint, answer);
    sent = [];
    const result = await push.sendPush(max.id, { title: "x", body: "y" });
    return { ...result, requests: sent.length };
  };
  assert.deepEqual(await tries([503, 201]), { rows: 1, sent: 1, gone: 0, requests: 2 });
  assert.deepEqual(await tries([new TypeError("fetch failed"), 201]), { rows: 1, sent: 1, gone: 0, requests: 2 });
  assert.deepEqual(await tries([{ status: 429, headers: { "retry-after": "0" } }, 201]), { rows: 1, sent: 1, gone: 0, requests: 2 });
  assert.deepEqual(await tries([500, 410]), { rows: 1, sent: 0, gone: 1, requests: 2 }, "a second answer of gone still deletes it");
  await pushRoute.POST(call("POST", max.cookie, phone.sub));
  assert.deepEqual(await tries([503, 503, 201]), { rows: 1, sent: 0, gone: 0, requests: 2 }, "two tries at most");
  // A push service that asks for a longer wait, or refuses the alert itself, isn't asked again.
  assert.deepEqual(await tries([{ status: 503, headers: { "retry-after": "60" } }, 201]), { rows: 1, sent: 0, gone: 0, requests: 1 });
  assert.deepEqual(await tries([400, 201]), { rows: 1, sent: 0, gone: 0, requests: 1 });
  assert.equal((await rowsOf(max.id)).length, 1, "the address stays for next time");
  answers.delete(phone.endpoint);
});

test("a sign-in on top of another in a browser stops the alerts the one before turned on there", async () => {
  const kim = await account("kim@example.com");
  const lee = await account("lee@example.com");
  const laptop = browser(`${FCM}family-laptop`);
  const phone = browser(`${FCM}kim-phone`);
  await pushRoute.POST(call("POST", kim.cookie, laptop.sub));
  await pushRoute.POST(call("POST", await signIn(kim), phone.sub));
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
  const signInOnTop = async (route: { POST: (r: Request) => Promise<Response> }, path: string, cookie: string, body: object) => {
    const res = await route.POST(
      new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie }, body: JSON.stringify(body) }),
    );
    assert.equal(res.status, 200, path);
    return cookieOf(res);
  };
  const reaches = async (userId: string) => {
    sent = [];
    await push.sendPush(userId, { title: "Payroll check", body: "Your salary arrived" });
    return sent.map((s) => s.url);
  };

  // Lee opens an emailed sign-in link on the laptop while Kim is still signed in there.
  const leeCookie = await signInOnTop(linkRoute, "/api/auth/email-link", kim.cookie, { token: await createSignInLink(lee.email, "/"), email: lee.email });
  assert.deepEqual(await reaches(kim.id), [phone.endpoint], "Kim's phone still gets hers, the laptop doesn't");
  // Lee turns alerts on there (the same push address), then Kim signs in on top with her password.
  await pushRoute.POST(call("POST", leeCookie, laptop.sub));
  const kimCookie = await signInOnTop(loginRoute, "/api/auth/login", leeCookie, { email: kim.email, password: "old password" });
  assert.deepEqual(await reaches(lee.id), []);
  // Kim turns them on there again, and someone makes a new account on top.
  await pushRoute.POST(call("POST", kimCookie, laptop.sub));
  assert.deepEqual((await reaches(kim.id)).sort(), [laptop.endpoint, phone.endpoint].sort());
  await signInOnTop(signupRoute, "/api/auth/signup", kimCookie, { email: "mo@example.com", password: "a long password", name: "Mo" });
  assert.deepEqual(await reaches(kim.id), [phone.endpoint]);
  // Nobody was signed out by it: only alerts stopped.
  assert.equal((await all("SELECT 1 FROM sessions WHERE user_id = ?", [kim.id])).length, 3);
});

test("one row per sign-in, and /admin counts only browsers alerts can still reach", async () => {
  const before = await push.pushBrowsers();
  const nia = await account("nia@example.com");
  const old = browser(`${FCM}nia-old`);
  const renewed = browser(`${FCM}nia-new`);
  await pushRoute.POST(call("POST", nia.cookie, old.sub));
  assert.equal(await push.pushBrowsers(), before + 1);
  // The same sign-in with a new push address (new keys, or the browser renewed it): the old one goes.
  await pushRoute.POST(call("POST", nia.cookie, renewed.sub));
  assert.deepEqual((await rowsOf(nia.id)).map((r) => r.endpoint), [renewed.endpoint]);
  assert.equal(await push.pushBrowsers(), before + 1);
  // A sign-in that ended by itself isn't counted, and /admin's count deletes its row.
  await run("UPDATE sessions SET expires_at = 1 WHERE user_id = ?", [nia.id]);
  assert.equal((await rowsOf(nia.id)).length, 1);
  assert.equal(await push.pushBrowsers(), before);
  assert.deepEqual(await rowsOf(nia.id), []);
});

test("a sign-in that ended by itself loses its push address and keys without waiting for an alert", async () => {
  const ed = await account("ed.expired@example.com");
  const laptop = browser(`${FCM}ed-old-laptop`);
  await pushRoute.POST(call("POST", ed.cookie, laptop.sub));
  const phone = browser(`${FCM}ed-phone`);
  const phoneCookie = await signIn(ed);
  await pushRoute.POST(call("POST", phoneCookie, phone.sub));
  // Thirty days on, the laptop's sign-in ends by itself; Ed only uses Flash on his phone.
  await run("UPDATE sessions SET expires_at = 1 WHERE token_hash = ?", [(await rowsOf(ed.id)).find((r) => r.endpoint === laptop.endpoint)!.session_hash]);
  sent = [];
  const res = await pushRoute.GET(new Request(`${ORIGIN}/api/push?e=${createHash("sha256").update(phone.endpoint).digest("hex")}`, { headers: { cookie: phoneCookie } }));
  assert.equal((await res.json()).on, true);
  assert.deepEqual((await rowsOf(ed.id)).map((r) => r.endpoint), [phone.endpoint], "the laptop's row went, the phone's stays");
  assert.deepEqual(sent, [], "no alert was needed for it");
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
    assert.deepEqual(push.pushSetup(), { setUp: false, keysOk: false, missing: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"], problem: "" });
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
    // With VAPID_SUBJECT missing or wrong as well, the two keys are still checked first: /admin says
    // to keep them only when they work, so adding the subject is never followed by new keys and a
    // second redeploy.
    for (const subject of [undefined, "hello@flash-app.dev"]) {
      if (subject === undefined) delete process.env.VAPID_SUBJECT;
      else process.env.VAPID_SUBJECT = subject;
      const both = push.pushSetup();
      assert.match(both.problem, /doesn't belong to VAPID_PUBLIC_KEY/, String(subject));
      assert.deepEqual([both.keysOk, both.missing], [false, subject === undefined ? ["VAPID_SUBJECT"] : []], String(subject));
    }
    process.env.VAPID_PUBLIC_KEY = "not-a-key";
    process.env.VAPID_PRIVATE_KEY = "also-not-a-key";
    delete process.env.VAPID_SUBJECT;
    assert.deepEqual(push.pushSetup(), {
      setUp: false,
      keysOk: false,
      missing: ["VAPID_SUBJECT"],
      problem: "VAPID_PUBLIC_KEY isn't a P-256 public key (65 bytes in base64url)",
    });
    // Keys that work, with only the subject missing or wrong: those are the only cases where /admin
    // says to keep them.
    setKeys(true);
    delete process.env.VAPID_SUBJECT;
    assert.deepEqual(push.pushSetup(), { setUp: false, keysOk: true, missing: ["VAPID_SUBJECT"], problem: "" });
    process.env.VAPID_SUBJECT = "hello@flash-app.dev";
    assert.deepEqual(push.pushSetup(), { setUp: false, keysOk: true, missing: [], problem: "VAPID_SUBJECT must be a mailto: address or an https:// address" });
  } finally {
    setKeys(true);
  }
  assert.deepEqual(push.pushSetup(), { setUp: true, keysOk: true, missing: [], problem: "" });
  assert.equal(push.pushPublicKey(), KEYS.VAPID_PUBLIC_KEY);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?", [jo.id]))?.n, 1, "rows wait for the keys");
});

// A window of Flash's: its path, and whether it's showing and in front (neither, for a path alone).
type Window = { url: string; visibilityState?: "visible" | "hidden"; focused?: boolean };

/**
 * public/sw.js run as a browser runs it, with Flash's real GET /api/push for its questions (sent
 * with cookie(), the browser's session cookie now): what it shows, the windows a tap opens or
 * focuses, and whether its push subscription is kept.
 */
function serviceWorker(endpoint: string, cookie: () => string, windows: (string | Window)[] = []) {
  const listeners: Record<string, (event: object) => void> = {};
  type Options = { body: string; tag?: string; renotify?: boolean; data: { url: string } };
  const shown: { title: string; options: Options }[] = [];
  // What's on the screen now: a new alert with the tag of one there takes its place, as in browsers.
  const tray: { title: string; body: string; tag: string; close(): void }[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const told: { url: string; message: unknown }[] = [];
  const state = { subscribed: true, offline: false, badges: 0 };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: object) => void) => void (listeners[type] = listener),
    skipWaiting() {},
    navigator: { setAppBadge: async () => void state.badges++ },
    registration: {
      // As plain objects of this realm (the worker's are its own), so they compare as they look.
      showNotification: async (title: string, options: object) => {
        const plain = JSON.parse(JSON.stringify(options)) as Options;
        shown.push({ title, options: plain });
        const tag = plain.tag ?? "";
        const notification = {
          title,
          body: plain.body,
          tag,
          close: () => {
            const at = tray.indexOf(notification);
            if (at >= 0) tray.splice(at, 1);
          },
        };
        const same = tag ? tray.findIndex((n) => n.tag === tag) : -1;
        if (same >= 0) tray[same] = notification;
        else tray.push(notification);
      },
      getNotifications: async () => [...tray],
      pushManager: {
        getSubscription: async () => (state.subscribed ? { endpoint, unsubscribe: async () => !(state.subscribed = false) } : null),
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () =>
        windows.map((w) => {
          const { url, visibilityState = "hidden", focused: inFront = false } = typeof w === "string" ? { url: w } : w;
          return {
            url: ORIGIN + url,
            visibilityState,
            focused: inFront,
            postMessage: (message: unknown) => void told.push({ url, message: JSON.parse(JSON.stringify(message)) }),
            focus: async () => void focused.push(url),
          };
        }),
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  const ask = async (path: string) => {
    if (state.offline) throw new TypeError("Failed to fetch");
    return pushRoute.GET(new Request(new URL(path, ORIGIN), { headers: { cookie: cookie() } }));
  };
  vm.runInContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), vm.createContext({ self, URL, Promise, Response, TextEncoder, crypto, AbortSignal, fetch: ask }));
  const fire = (type: string, event: object) => {
    let waited: Promise<unknown> = Promise.resolve();
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => void (waited = p) });
    return waited;
  };
  return {
    shown,
    // What's on the screen: title, text and tag.
    tray: () => tray.map(({ title, body, tag }) => ({ title, body, tag })),
    opened,
    focused,
    told,
    state,
    push: (data: string) => fire("push", { data: { json: () => JSON.parse(data) } }),
    tap: (url: string) => fire("notificationclick", { notification: { close() {}, data: { url } } }),
  };
}

test("an alert that waited at the push service shows its words only if the sign-in there is still live", async () => {
  const ana = await account("ana.laptop@example.com");
  const phoneCookie = await signIn(ana);
  const laptop = browser(`${FCM}family-laptop-asleep`);
  assert.equal((await pushRoute.POST(call("POST", ana.cookie, laptop.sub))).status, 200);
  let cookie = ana.cookie;
  const worker = serviceWorker(laptop.endpoint, () => cookie);
  // Alerts the push service holds while the laptop sleeps (up to its TTL), opened as the browser gets them.
  const waiting = async (body: string) => {
    sent = [];
    await push.sendPush(ana.id, { title: "Payroll check", body, url: "/?automations=a1", tag: "flash-run-r1" });
    return laptop.open(sent[0].body);
  };

  // Still signed in there: the alert shows as it was sent.
  await worker.push(await waiting("Your salary arrived"));
  assert.deepEqual(worker.shown.at(-1), {
    title: "Payroll check",
    options: { body: "Your salary arrived", icon: "/app-icon/192?v=3", tag: "flash-run-r1", renotify: true, data: { url: `${ORIGIN}/?automations=a1&as=${ana.id}` } },
  });
  // No answer from Flash: Flash's name only, and the subscription stays.
  const later = await waiting("Your salary of $4,210 arrived");
  worker.state.offline = true;
  await worker.push(later);
  assert.deepEqual(worker.shown.at(-1), { title: "Flash ∞ AI", options: { body: "", icon: "/app-icon/192?v=3", data: { url: `${ORIGIN}/` }, tag: "flash-hidden", renotify: false } });
  assert.equal(worker.state.subscribed, true);
  worker.state.offline = false;

  // From her phone, "Log out of all devices", while the laptop sleeps; then someone else opens it.
  const out = await logoutRoute.POST(
    new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { "content-type": "application/json", cookie: phoneCookie }, body: JSON.stringify({ everywhere: true }) }),
  );
  assert.equal(out.status, 200);
  await worker.push(later);
  assert.deepEqual(worker.shown.at(-1), { title: "Flash ∞ AI", options: { body: "", icon: "/app-icon/192?v=3", data: { url: `${ORIGIN}/` }, tag: "flash-hidden", renotify: false } }, "none of her words");
  assert.equal(worker.state.subscribed, false, "and nothing else waiting for that address arrives");

  // The same for a sign-in that ended by itself, or a browser no longer signed in at all.
  for (const end of ["expired", "signed out"]) {
    const bo = await account(`bo.${end.replace(" ", "")}@example.com`);
    const pc = browser(`${FCM}bo-${end.replace(" ", "")}`);
    await pushRoute.POST(call("POST", bo.cookie, pc.sub));
    sent = [];
    await push.sendPush(bo.id, { title: "Invoice check", body: "Paid" });
    const alert = pc.open(sent[0].body);
    cookie = bo.cookie;
    const sw = serviceWorker(pc.endpoint, () => cookie);
    if (end === "expired") await run("UPDATE sessions SET expires_at = 1 WHERE user_id = ?", [bo.id]);
    else cookie = "";
    await sw.push(alert);
    assert.deepEqual(sw.shown.map((n) => [n.title, n.options.body]), [["Flash ∞ AI", ""]], end);
    assert.equal(sw.state.subscribed, false, end);
  }
});

test("alerts whose words are held back show as one, and a sign-in that ended takes its earlier alerts off the screen", async () => {
  const ana = await account("ana.hourly@example.com");
  const phoneCookie = await signIn(ana);
  const laptop = browser(`${FCM}family-laptop-hourly`);
  await pushRoute.POST(call("POST", ana.cookie, laptop.sub));
  const worker = serviceWorker(laptop.endpoint, () => ana.cookie);
  // An hourly automation's alerts, each run with its own tag.
  const alertOf = async (run: string) => {
    sent = [];
    await push.sendPush(ana.id, { title: "Ana's weekly money check", body: `Overdraft in 3 days (${run})`, tag: `flash-run-${run}` });
    return laptop.open(sent[0].body);
  };
  // Signed in there: it shows, and stays on the screen until she dismisses it.
  await worker.push(await alertOf("r1"));
  const hers = { title: "Ana's weekly money check", body: "Overdraft in 3 days (r1)", tag: "flash-run-r1" };
  const hidden = { title: "Flash ∞ AI", body: "", tag: "flash-hidden" };
  assert.deepEqual(worker.tray(), [hers]);

  // No answer from Flash as three arrive: one "Flash ∞ AI", and hers stays, since she may still be signed in.
  worker.state.offline = true;
  for (const run of ["r2", "r3", "r4"]) await worker.push(await alertOf(run));
  assert.deepEqual(worker.tray(), [hers, hidden]);
  worker.state.offline = false;

  // "Log out of all devices" from her phone while the laptop sleeps with five alerts waiting for it.
  const waiting = [];
  for (const run of ["r5", "r6", "r7", "r8", "r9"]) waiting.push(await alertOf(run));
  await logoutRoute.POST(
    new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { "content-type": "application/json", cookie: phoneCookie }, body: JSON.stringify({ everywhere: true }) }),
  );
  for (const alert of waiting) await worker.push(alert);
  assert.deepEqual(worker.tray(), [hidden], "none of her words stay for the next person, and no pile of empty alerts");
  assert.deepEqual(
    worker.shown.filter((n) => n.options.tag === "flash-hidden").map((n) => n.options.renotify),
    [false, false, false, false, false, false, false, false],
    "one that takes another's place doesn't alert again",
  );
});

test("\"Log out of all devices\" or a password change takes her alerts off the screens of her other browsers", async () => {
  const payroll = { title: "Payroll check", body: "Your salary of $4,210 arrived", tag: "flash-run-r1" };
  for (const how of ["everywhere", "password"]) {
    const ana = await account(`ana.library.${how}@example.com`);
    const phoneCookie = await signIn(ana);
    // Alerts on at a library computer, which she leaves with Flash closed, and on her phone.
    const library = browser(`${FCM}library-pc-${how}`);
    const phone = browser(`${FCM}ana-phone-${how}`);
    await pushRoute.POST(call("POST", ana.cookie, library.sub));
    await pushRoute.POST(call("POST", phoneCookie, phone.sub));
    // A browser where Ben has alerts on too: a push there would be checked against his sign-in, show
    // him an empty alert and leave hers, so none goes there.
    const ben = await account(`ben.library.${how}@example.com`);
    const shared = browser(`${FCM}shared-pc-${how}`);
    await pushRoute.POST(call("POST", await signIn(ana), shared.sub));
    await pushRoute.POST(call("POST", ben.cookie, shared.sub));
    const worker = serviceWorker(library.endpoint, () => ana.cookie);
    sent = [];
    await push.sendPush(ana.id, payroll);
    await worker.push(library.open(sent.find((s) => s.url === library.endpoint)!.body));
    assert.deepEqual(worker.tray(), [payroll]);

    // At home, on her phone.
    sent = [];
    const out =
      how === "everywhere"
        ? await logoutRoute.POST(
            new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: phoneCookie }, body: JSON.stringify({ everywhere: true }) }),
          )
        : await passwordRoute.POST(
            new Request(`${ORIGIN}/api/me/password`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: phoneCookie }, body: JSON.stringify({ current: "old password", next: "a brand new password" }) }),
          );
    assert.equal(out.status, 200, how);
    // One push with no words to the library computer; none to the phone she pressed it on (its own
    // screen is its page's to clear), nor to the browser that's Ben's now.
    assert.deepEqual(sent.map((s) => s.url), [library.endpoint], how);
    assert.deepEqual(library.read(sent[0].body), {});
    assert.deepEqual(await rowsOf(ana.id), []);
    // Its service worker hears her sign-in is gone: her alert leaves the screen, and so does the subscription.
    await worker.push(library.open(sent[0].body));
    assert.deepEqual(worker.tray(), [{ title: "Flash ∞ AI", body: "", tag: "flash-hidden" }], how);
    assert.equal(worker.state.subscribed, false, how);
  }
  // A password reset from an emailed link, or anything else that ends every sign-in, does the same.
  const cy = await account("cy.library@example.com");
  const pc = browser(`${FCM}cy-library`);
  await pushRoute.POST(call("POST", cy.cookie, pc.sub));
  sent = [];
  await endAllSessions(cy.id);
  assert.deepEqual(sent.map((s) => s.url), [pc.endpoint]);
  // With the keys taken off the server, the rows still go, and nothing is sent.
  const di = await account("di.library@example.com");
  await pushRoute.POST(call("POST", di.cookie, browser(`${FCM}di-library`).sub));
  setKeys(false);
  try {
    sent = [];
    await endAllSessions(di.id);
    assert.deepEqual(sent, []);
    assert.deepEqual(await rowsOf(di.id), []);
  } finally {
    setKeys(true);
  }
});

test("an alert puts a dot on the app's icon, unless Flash is on the screen and in front", async () => {
  const di = await account("di.badge@example.com");
  const phone = browser(`${FCM}di-badge`);
  await pushRoute.POST(call("POST", di.cookie, phone.sub));
  const test = JSON.stringify({ title: "Flash ∞ AI", body: "Alerts work on this device.", tag: "flash-test" });
  const dots = async (windows: (string | Window)[]) => {
    const worker = serviceWorker(phone.endpoint, () => di.cookie, windows);
    await worker.push(test);
    assert.equal(worker.shown.length, 1);
    return worker.state.badges;
  };
  assert.equal(await dots([{ url: "/", visibilityState: "visible", focused: true }]), 0, "the test alert pressed in Flash");
  assert.equal(await dots([]), 1, "Flash closed");
  assert.equal(await dots([{ url: "/?chat=p1", visibilityState: "hidden" }]), 1, "Flash in a tab behind another");
  assert.equal(await dots([{ url: "/", visibilityState: "visible", focused: false }]), 1, "Flash's window behind another app's");
  assert.equal(await dots([{ url: "/privacy", visibilityState: "visible", focused: true }]), 1, "another Flash page, which doesn't clear it");
});

test("an alert without a tag shows on its own; one with a tag replaces the last and still alerts", async () => {
  const cy = await account("cy.tags@example.com");
  const phone = browser(`${FCM}cy-tags`);
  await pushRoute.POST(call("POST", cy.cookie, phone.sub));
  const tagOf = async (tag?: string) => {
    sent = [];
    await push.sendPush(cy.id, { title: "Weekly summary", body: "Ready", ...(tag === undefined ? {} : { tag }) });
    return phone.read(sent[0].body).tag;
  };
  assert.equal(await tagOf(), undefined, "none given: none sent, so it doesn't replace another alert");
  assert.equal(await tagOf("flash run 1"), undefined, "nor for one Flash doesn't take");
  assert.equal(await tagOf(`flash-run-${"r".repeat(60)}`), undefined);
  assert.equal(await tagOf("flash-run-r1"), "flash-run-r1");

  const worker = serviceWorker(phone.endpoint, () => cy.cookie);
  await worker.push(JSON.stringify({ title: "Weekly summary", body: "Ready" }));
  await worker.push(JSON.stringify({ title: "Invoice check", body: "Paused: credits ran out" }));
  await worker.push(JSON.stringify({ title: "Flash ∞ AI", body: "Alerts work on this device.", tag: "flash-test" }));
  assert.deepEqual(
    worker.shown.map((n) => [n.title, n.options.tag, n.options.renotify]),
    [
      ["Weekly summary", undefined, undefined],
      ["Invoice check", undefined, undefined],
      ["Flash ∞ AI", "flash-test", true],
    ],
  );
});

test("a tap on an alert opens Flash itself, never another Flash page that's open", async () => {
  const url = `${ORIGIN}/?automations=a1&as=u1`;
  // Only Flash's privacy page, a shared chat and /admin are open: Flash opens on the alert's page.
  const others = serviceWorker(`${FCM}x`, () => "", ["/privacy", "/s/abc123", "/admin"]);
  await others.tap(url);
  assert.deepEqual(others.opened, [url]);
  assert.deepEqual([others.focused, others.told], [[], []]);
  // With Flash open too, that's the one brought to the front.
  const both = serviceWorker(`${FCM}x`, () => "", ["/privacy", "/?chat=p1"]);
  await both.tap(url);
  assert.deepEqual([both.opened, both.focused, both.told], [[], ["/?chat=p1"], [{ url: "/?chat=p1", message: { type: "flash:open", url } }]]);
  // A link that isn't Flash's opens Flash's home.
  const none = serviceWorker(`${FCM}x`, () => "");
  await none.tap("https://evil.example/");
  assert.deepEqual(none.opened, [`${ORIGIN}/`]);
});
