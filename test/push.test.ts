import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createDecipheriv, createECDH, createHash, createHmac, createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/*
 * Alerts when Flash is closed (Web Push, src/lib/server/push.ts): the VAPID signature, RFC 8291's
 * encryption against its own example, dead addresses deleted, a busy push service tried twice, the
 * account named in a browser shared by several, alerts stopping with a sign-out or a sign-in on top,
 * and alerts going only to known push services.
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
    read: (body: Buffer) => JSON.parse(decrypt(body, ua.getPrivateKey(), auth)) as { title: string; body: string; url: string; tag: string },
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
  // A sign-in that ended by itself isn't counted, though its row waits for the next alert to go.
  await run("UPDATE sessions SET expires_at = 1 WHERE user_id = ?", [nia.id]);
  assert.equal((await rowsOf(nia.id)).length, 1);
  assert.equal(await push.pushBrowsers(), before);
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
