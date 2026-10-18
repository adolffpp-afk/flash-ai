/*
 * Alerts on people's phones and computers, even when Flash is closed (Web Push, RFC 8030). It costs
 * Flash nothing and needs no package and no Google project: each alert is encrypted for the browser
 * that asked for it (RFC 8291, "aes128gcm") and signed with Flash's own key pair (VAPID, RFC 8292),
 * both with node:crypto, and the browser maker's push service (Google's for Chrome and Android,
 * Mozilla's, Apple's, Microsoft's) only carries it, unable to read it.
 *
 * The key pair is made on /admin, in the admin's own browser, and set in Vercel as VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY and VAPID_SUBJECT. Until all three are set and belong together, nobody sees the
 * alerts setting (the GET in api/push has no key to give) and sendPush does nothing.
 *
 * Each row of push_subscriptions (db.ts) is one account in one browser, tied to that account's
 * sign-in there: it goes when they log out there (endSession), when someone else signs in on top of
 * it there (leaveBrowser), on endAllSessions (a password reset or change, "Log out of all devices"),
 * and alerts only ever go to browsers where that sign-in is still live, so on a shared computer
 * nobody who signs in next sees them.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { all, db, one, run, now } from "./db.ts";
import { sha256 } from "./ids.ts";
import { translatorIn } from "./i18n.ts";
import { PRODUCT_NAME } from "../product.ts";

const VAPID_NAMES = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
// The most browsers one account gets alerts in; turning them on in another drops the oldest.
const MAX_BROWSERS = 20;
// The longest an alert waits at the push service for a phone that's off, in seconds.
const TTL = 24 * 3600;
// What the title and text of an alert keep: an automation's name, and its summary (plan §11).
const TITLE_CHARS = 80;
const BODY_CHARS = 120;
// The longest page address an alert opens (a longer one opens Flash's home), so every alert fits in one record.
const URL_CHARS = 1024;
// How long one alert may take at the push service, a second try included.
const SEND_MS = 10_000;
// The longest wait before that second try: a push service that asks for longer gets no second try.
const RETRY_MS = 3_000;

/*
 * The push services browsers use, and the only addresses Flash sends alerts to, so a made-up
 * "subscription" can't make Flash's server call anywhere else: Google's FCM (Chrome, Android,
 * Edge on Android, Samsung Internet, Opera), Mozilla (Firefox), Apple (Safari on a Mac, and Flash
 * added to an iPhone or iPad Home Screen) and Microsoft's WNS (Edge on Windows: one host per region,
 * like wns2-par02p.notify.windows.com).
 */
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const WNS = ".notify.windows.com";

/** Whether an address is https on a known push service, with no user, password or port in it. */
export function pushEndpointOk(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname;
  return PUSH_HOSTS.has(host) || (host.endsWith(WNS) && /^[a-z0-9-]+$/.test(host.slice(0, -WNS.length)));
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** base64url (padding allowed) to bytes, or null when it isn't base64url at all. */
function bytesOf(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

type Keys = { publicKey: Buffer; publicText: string; privateKey: KeyObject; subject: string };
// keysOk: the two keys are set and belong together, so only VAPID_SUBJECT can be what's wrong.
type Setup = { keys: Keys | null; keysOk: boolean; missing: string[]; problem: string };

let cached: { from: string; setup: Setup } | null = null;

/** Reads the VAPID variables (cached until they change): the keys, or what's missing or wrong, by name only. */
function setup(env: Record<string, string | undefined> = process.env): Setup {
  const [pub, priv, subject] = VAPID_NAMES.map((name) => env[name]?.trim() ?? "");
  const from = sha256(`${pub}\n${priv}\n${subject}`);
  if (cached?.from === from) return cached.setup;
  const result = readKeys(pub, priv, subject);
  cached = { from, setup: result };
  return result;
}

/** The key pair in the two VAPID keys, or what's wrong with them. */
function keyPair(pub: string, priv: string): { publicKey: Buffer; privateKey: KeyObject } | string {
  const publicKey = bytesOf(pub);
  const d = bytesOf(priv);
  if (!publicKey || publicKey.length !== 65 || publicKey[0] !== 4) return "VAPID_PUBLIC_KEY isn't a P-256 public key (65 bytes in base64url)";
  if (!d || d.length !== 32) return "VAPID_PRIVATE_KEY isn't a P-256 private key (32 bytes in base64url)";
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey().equals(publicKey)) return "VAPID_PRIVATE_KEY doesn't belong to VAPID_PUBLIC_KEY (make both again, together)";
    const privateKey = createPrivateKey({
      key: { kty: "EC", crv: "P-256", d: b64(d), x: b64(publicKey.subarray(1, 33)), y: b64(publicKey.subarray(33)) },
      format: "jwk",
    });
    return { publicKey, privateKey };
  } catch {
    return "VAPID_PRIVATE_KEY isn't a P-256 private key";
  }
}

function readKeys(pub: string, priv: string, subject: string): Setup {
  const missing = VAPID_NAMES.filter((_, i) => ![pub, priv, subject][i]);
  // The two keys first, even with VAPID_SUBJECT missing or wrong: /admin says to keep them only when they work.
  const pair = pub && priv ? keyPair(pub, priv) : null;
  if (typeof pair === "string") return { keys: null, keysOk: false, missing, problem: pair };
  if (!pair || missing.length) return { keys: null, keysOk: Boolean(pair), missing, problem: "" };
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    return { keys: null, keysOk: true, missing: [], problem: "VAPID_SUBJECT must be a mailto: address or an https:// address" };
  }
  return { keys: { publicKey: pair.publicKey, publicText: b64(pair.publicKey), privateKey: pair.privateKey, subject }, keysOk: true, missing: [], problem: "" };
}

/** The public key browsers subscribe with, or null while alerts aren't set up on this server. */
export const pushPublicKey = (): string | null => setup().keys?.publicText ?? null;

/**
 * For /admin: whether alerts are set up, whether the two keys work (then only VAPID_SUBJECT is left
 * to fix), and the variables missing or wrong (names only, never values).
 */
export function pushSetup(): { setUp: boolean; keysOk: boolean; missing: string[]; problem: string } {
  const { keys, keysOk, missing, problem } = setup();
  return { setUp: Boolean(keys), keysOk, missing, problem };
}

/**
 * The Authorization header for one push (RFC 8292): a JWT signed with ES256 for the push service's
 * origin, good for 12 hours (push services refuse more than 24), and the public key it was signed with.
 */
export function vapidHeader(endpoint: string, at = now()): string {
  const keys = setup().keys;
  if (!keys) throw new Error("Push keys aren't set.");
  const part = (value: object) => b64(Buffer.from(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(at / 1000) + 12 * 3600, sub: keys.subject })}`;
  // JWTs carry the two 32-byte halves of the signature as they are (IEEE P1363), not DER.
  const signature = sign("sha256", Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicText}`;
}

const hmac = (key: Buffer, ...parts: Buffer[]) => {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
};

// What one record holds (RFC 8291 section 4): 4096 bytes less the header (86), the padding delimiter and the tag.
export const MAX_PLAINTEXT = 3993;

/**
 * Encrypts an alert for one browser (RFC 8291, aes128gcm, one record). uaPublic and authSecret are
 * the browser's own keys from its subscription. A new key pair and salt are made for every alert;
 * fixed gives them instead, for the RFC's test vector (Appendix A).
 */
export function encryptPush(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, fixed?: { salt: Buffer; serverPrivate: Buffer }): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("An alert can hold at most 3993 bytes.");
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.serverPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  // Throws for a key that isn't a point on P-256 (the RFC's security considerations).
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (and only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  // The header: salt, record size (4096), and the key id, which is Flash's one-time public key.
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

export type Subscription = { endpoint: string; p256dh: string; auth: string };

/**
 * A browser's subscription (PushSubscription.toJSON()) checked: its address on a known push service,
 * its public key a point on P-256 and its secret 16 bytes. Null for anything else.
 */
export function checkSubscription(value: unknown): Subscription | null {
  const sub = (value ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!pushEndpointOk(sub.endpoint)) return null;
  const p256dh = bytesOf(sub.keys?.p256dh);
  const auth = bytesOf(sub.keys?.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4 || !auth || auth.length !== 16) return null;
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(p256dh);
  } catch {
    return null;
  }
  return { endpoint: sub.endpoint, p256dh: b64(p256dh), auth: b64(auth) };
}

/**
 * Turns alerts on for this account in this browser (sessionHash: its sign-in here). A sign-in is in
 * one browser, which has one push address at a time, so an older address of this sign-in goes.
 */
export async function savePush(userId: string, sessionHash: string, sub: Subscription): Promise<void> {
  await (await db()).batch(
    [
      { sql: "DELETE FROM push_subscriptions WHERE session_hash = ? AND user_id = ? AND endpoint <> ?", args: [sessionHash, userId, sub.endpoint] },
      {
        sql: `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, session_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(endpoint, user_id) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, session_hash = excluded.session_hash`,
        args: [sub.endpoint, userId, sub.p256dh, sub.auth, sessionHash, now()],
      },
      {
        sql: `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN
                (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_BROWSERS})`,
        args: [userId, userId],
      },
    ],
    "write",
  );
}

/** Turns alerts off for this account in the browser with this push address. */
export async function removePush(userId: string, endpoint: string): Promise<void> {
  await run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", [endpoint, userId]);
}

/**
 * Whether this account gets alerts in this browser: a row for its sign-in here (sessionHash) whose
 * push address has this SHA-256 (the page sends the hash, so the address stays out of server logs).
 */
export async function pushOnHere(userId: string, sessionHash: string, endpointHash: string): Promise<boolean> {
  const rows = await all<{ endpoint: string }>(
    `SELECT p.endpoint FROM push_subscriptions p JOIN sessions s ON s.token_hash = p.session_hash AND s.user_id = p.user_id
     WHERE p.user_id = ? AND p.session_hash = ? AND s.expires_at > ?`,
    [userId, sessionHash, now()],
  );
  return rows.some((r) => sha256(r.endpoint) === endpointHash);
}

/** What an alert says, already in the account's language. */
export type PushNotice = {
  // Shown in bold, like an automation's name; at most 80 characters are kept.
  title: string;
  // The summary under it; at most 120 characters are kept.
  body: string;
  // The Flash page a tap opens, like "/?automations=<id>&run=<runId>"; as=<userId> is added, so it
  // opens as this account in a browser signed in to several. Anything that isn't Flash's, or is
  // longer than 1024 characters, opens "/".
  url?: string;
  // A later alert with the same tag replaces this one (and still alerts), like "flash-run-<runId>".
  // Without one, or with one that isn't 1-64 letters, digits, "_", ":", "." or "-", each alert shows on its own.
  tag?: string;
};

/** Text on one line, cut to max characters (whole characters, so an emoji is never split). */
function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
}

/** A path on Flash with as=<userId>, or "/" with it for anything that would leave Flash or is too long. */
function pagePath(url: string | undefined, userId: string): string {
  const base = "https://flash.invalid";
  let page: URL;
  try {
    page = new URL(url || "/", base);
  } catch {
    page = new URL("/", base);
  }
  if (page.origin !== base) page = new URL("/", base);
  page.searchParams.set("as", userId);
  const path = `${page.pathname}${page.search}${page.hash}`;
  return path.length > URL_CHARS ? pagePath("/", userId) : path;
}

/** A Retry-After header (seconds, or a date) in milliseconds, or null without one. */
function retryAfter(value: string | null): number | null {
  if (!value) return null;
  const ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

type Row = { endpoint: string; p256dh: string; auth: string; others: number };
type Outcome = "sent" | "gone" | "failed";

async function deliver(row: Row, payload: object): Promise<Outcome> {
  if (!pushEndpointOk(row.endpoint)) return "gone";
  const plaintext = Buffer.from(JSON.stringify(payload));
  // Too long for one record (the limits above keep every alert shorter): this alert fails, the browser stays.
  if (plaintext.length > MAX_PLAINTEXT) return "failed";
  let body: Buffer;
  try {
    body = encryptPush(plaintext, Buffer.from(row.p256dh, "base64url"), Buffer.from(row.auth, "base64url"));
  } catch {
    // The browser's key isn't a point on P-256: no alert can ever reach it.
    return "gone";
  }
  const deadline = Date.now() + SEND_MS;
  for (let tries = 1; ; tries++) {
    // 0 for no answer: a network error, or none in time.
    let status = 0;
    let wait = 500;
    try {
      const res = await fetch(row.endpoint, {
        method: "POST",
        // A push service never redirects; following one could lead anywhere.
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        headers: {
          Authorization: vapidHeader(row.endpoint),
          TTL: String(TTL),
          Urgency: "normal",
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(body),
      });
      await res.body?.cancel().catch(() => {});
      // The browser unsubscribed, or the address expired: it will never work again.
      if (res.status === 404 || res.status === 410) return "gone";
      if (res.ok) return "sent";
      status = res.status;
      wait = retryAfter(res.headers.get("retry-after")) ?? wait;
    } catch {
      // Tried once more below, like a busy push service.
    }
    // A busy push service (429, 5xx) or a lost connection gets one more try, within the same 10 seconds.
    const busy = status === 0 || status === 429 || status >= 500;
    if (tries === 1 && busy && wait <= RETRY_MS && Date.now() + wait + 1000 < deadline) {
      await new Promise((done) => setTimeout(done, wait));
      continue;
    }
    // The host and status only: the address itself works like a password for this browser.
    if (status) console.warn(`A push to ${new URL(row.endpoint).hostname} was refused (${status}).`);
    return "failed";
  }
}

/**
 * Sends an alert to every browser where this account turned alerts on and is still signed in, or
 * only to the one with the push address only. A browser signed in to several accounts that turned
 * alerts on gets the account named on the alert's first line ("For ana@example.com"). Addresses the
 * push service says are gone (404, 410) are deleted for every account; a busy one (429, 5xx) or a
 * lost connection gets a second try. Does nothing until the keys are set. rows counts the browsers
 * it tried, sent those that took it, and gone those deleted.
 */
export async function sendPush(userId: string, notice: PushNotice, only?: string): Promise<{ rows: number; sent: number; gone: number }> {
  if (!setup().keys) return { rows: 0, sent: 0, gone: 0 };
  const at = now();
  // Rows from a sign-in that ended without one of the deletes above (it expired) go first.
  await run(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM sessions s
       WHERE s.token_hash = push_subscriptions.session_hash AND s.user_id = push_subscriptions.user_id AND s.expires_at > ?)`,
    [userId, at],
  );
  const rows = await all<Row>(
    `SELECT p.endpoint, p.p256dh, p.auth,
       (SELECT COUNT(*) FROM push_subscriptions o JOIN sessions so ON so.token_hash = o.session_hash AND so.user_id = o.user_id
        WHERE o.endpoint = p.endpoint AND o.user_id <> p.user_id AND so.expires_at > ?) AS others
     FROM push_subscriptions p JOIN sessions s ON s.token_hash = p.session_hash AND s.user_id = p.user_id
     WHERE p.user_id = ? AND s.expires_at > ?${only === undefined ? "" : " AND p.endpoint = ?"}`,
    only === undefined ? [at, userId, at] : [at, userId, at, only],
  );
  if (!rows.length) return { rows: 0, sent: 0, gone: 0 };
  const user = await one<{ email: string; language: string }>("SELECT email, language FROM users WHERE id = ?", [userId]);
  const t = await translatorIn(user?.language || "en");
  const title = clip(notice.title, TITLE_CHARS) || PRODUCT_NAME;
  const body = clip(notice.body, BODY_CHARS);
  const url = pagePath(notice.url, userId);
  const tag = notice.tag && /^[\w:.-]{1,64}$/.test(notice.tag) ? notice.tag : undefined;
  const outcomes = await Promise.all(
    rows.map((row) => {
      const named = Number(row.others) > 0 && user ? [t("For {email}", { email: user.email }), body].filter(Boolean).join("\n") : body;
      return deliver(row, { title, body: named, url, tag }).then((outcome) => ({ row, outcome }));
    }),
  );
  const gone = outcomes.filter((o) => o.outcome === "gone").map((o) => o.row.endpoint);
  const sent = outcomes.filter((o) => o.outcome === "sent").map((o) => o.row.endpoint);
  const writes = [
    ...gone.map((endpoint) => ({ sql: "DELETE FROM push_subscriptions WHERE endpoint = ?", args: [endpoint] })),
    ...sent.map((endpoint) => ({ sql: "UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ? AND user_id = ?", args: [now(), endpoint, userId] })),
  ];
  if (writes.length) await (await db()).batch(writes, "write");
  return { rows: rows.length, sent: sent.length, gone: gone.length };
}

/** For /admin: how many browsers have alerts on, counting only rows whose sign-in is still live (the only ones sent to). */
export async function pushBrowsers(): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(DISTINCT p.endpoint) AS n FROM push_subscriptions p
     JOIN sessions s ON s.token_hash = p.session_hash AND s.user_id = p.user_id WHERE s.expires_at > ?`,
    [now()],
  );
  return Number(row?.n ?? 0);
}
