import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createECDH, generateKeyPairSync } from "node:crypto";

/*
 * Alerts when Flash is closed, in the browser (src/lib/push.ts) against Flash's own /api/push: a
 * stand-in browser (its push subscription, notification permission, storage and session cookie) and
 * stand-in push services. Turning alerts on makes a new subscription, so no other account's alerts
 * follow; a sign-in that ends by itself keeps this device's wish for alerts, and only logging out
 * here forgets it; and what the switch says when the browser asks, blocks, or has no push service.
 */
register("./support/route-hooks.mjs", import.meta.url);
const HOOKS = new URL("./support/push-react.mjs", import.meta.url).href;
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s, c, next) {
        if (s === "react" && c.parentURL?.endsWith("/src/lib/push.ts")) return { url: ${JSON.stringify(HOOKS)}, shortCircuit: true };
        const r = await next(s, c);
        return r.url.endsWith(".json") ? { ...r, importAttributes: { type: "json" } } : r;
      }`,
    ),
);
process.env.DATABASE_URL = ":memory:";
process.env.FLASH_DEMO_EMAILS = "true";
delete process.env.RESEND_API_KEY;
console.warn = () => {};

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
process.env.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
process.env.VAPID_PRIVATE_KEY = jwk.d!;
process.env.VAPID_SUBJECT = "mailto:hello@flash-app.dev";

const ORIGIN = "https://www.flash-app.dev";

// ---- The browser ----
let cookie = ""; // its flash_session cookie, "flash_session=..."
const storage = new Map<string, string>();
const permission = { now: "granted" as NotificationPermission, answer: "granted" as NotificationPermission };
let asks = 0;
let refuse: Error | null = null; // what pushManager.subscribe rejects with, if anything
const unsubscribed = new Set<string>();
let made = 0;
type Sub = { endpoint: string; options: { applicationServerKey: ArrayBuffer }; toJSON(): object; unsubscribe(): Promise<boolean> };
let current: Sub | null = null;
const registration = {
  pushManager: {
    getSubscription: async () => current,
    subscribe: async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
      if (refuse) throw refuse;
      const ua = createECDH("prime256v1");
      ua.generateKeys();
      const endpoint = `https://fcm.googleapis.com/fcm/send/browser-${++made}`;
      const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, made).toString("base64url") };
      const sub: Sub = {
        endpoint,
        options: { applicationServerKey: applicationServerKey.slice().buffer },
        toJSON: () => ({ endpoint, expirationTime: null, keys }),
        unsubscribe: async () => {
          unsubscribed.add(endpoint);
          if (current === sub) current = null;
          return true;
        },
      };
      return (current = sub);
    },
  },
};
Object.assign(globalThis, {
  window: globalThis,
  PushManager: class {},
  Notification: {
    get permission() {
      return permission.now;
    },
    requestPermission: async () => {
      asks++;
      return (permission.now = permission.answer);
    },
  },
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  document: { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} },
  dispatchEvent: () => true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0",
    maxTouchPoints: 0,
    serviceWorker: { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration },
  },
});

// ---- Flash's server, and the push services ----
const pushRoute = await import("../src/app/api/push/route.ts");
const reached: string[] = []; // push addresses an alert was sent to and taken
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/push")) {
    const request = new Request(ORIGIN + url, { method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>), origin: ORIGIN, cookie }, body: init?.body as string | undefined });
    return (pushRoute as unknown as Record<string, (r: Request) => Promise<Response>>)[request.method](request);
  }
  if (unsubscribed.has(url)) return new Response(null, { status: 410 });
  reached.push(url);
  return new Response(null, { status: 201 });
}) as typeof fetch;

const client = await import("../src/lib/push.ts");
const { render } = (await import(HOOKS)) as { render: (hook: () => void) => void };
const push = await import("../src/lib/server/push.ts");
const { createSession, hashPassword } = await import("../src/lib/server/auth.ts");
const { run, all } = await import("../src/lib/server/db.ts");

const t = ((text: string) => text) as never;
// The browser's subscription now (a function, as the code under test changes it).
const subNow = (): Sub | null => current;
const key = push.pushPublicKey()!;
const wanted = () => storage.get("flash:push-accounts") ?? "";
const rowsAt = (endpoint: string) => all<{ user_id: string }>("SELECT user_id FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
async function account(id: string) {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at, language) VALUES (?, ?, ?, 0, 1, '')", [id, `${id}@example.com`, await hashPassword("a password")]);
}
const signIn = async (id: string) => void (cookie = (await createSession(id, true)).split(";")[0]);
/** What reaches this browser now when the account is sent an alert. */
async function alertsHere(userId: string): Promise<number> {
  reached.length = 0;
  await push.sendPush(userId, { title: "Payroll check", body: "Your salary arrived" });
  return reached.filter((url) => url === current?.endpoint).length;
}
// usePushSync's work runs after the render, as an effect's does.
const settle = () => new Promise((done) => setTimeout(done, 100));

test("turning alerts on, or back on, makes a new subscription, so no other account's alerts follow", async () => {
  await account("ann");
  await account("bea");
  // Bea turns alerts on here; later her sign-in ends by itself, and the page drops the subscription.
  await signIn("bea");
  await client.turnOnPush("bea", key, t);
  await run("UPDATE sessions SET expires_at = 1 WHERE user_id = 'bea'");
  await client.syncPush(null);
  assert.equal(current, null);
  assert.equal(wanted(), "bea", "still wanted, for when she's back");

  // Ann signs in and turns alerts on here. The browser then loses its cookie (not its subscription),
  // so nothing on the server knows Ann left when Bea signs in again.
  await signIn("ann");
  await client.syncPush("ann");
  await client.turnOnPush("ann", key, t);
  const anns = subNow()!.endpoint;
  assert.equal(await alertsHere("ann"), 1);
  cookie = "";
  await signIn("bea");
  await client.syncPush("bea");
  const beas = subNow()?.endpoint ?? "";
  assert.ok(beas && beas !== anns, "Bea's alerts came back on with a subscription of their own");
  assert.deepEqual(await rowsAt(beas), [{ user_id: "bea" }]);
  assert.equal(await alertsHere("ann"), 0, "none of Ann's reach the browser Bea is using");
  assert.deepEqual(await rowsAt(anns), [], "her old address was found gone, and deleted");
  assert.equal(await alertsHere("bea"), 1);

  // The switch, too: turning alerts on never reuses a subscription someone else turned on.
  cookie = "";
  await signIn("ann");
  await client.turnOnPush("ann", key, t);
  assert.notEqual(subNow()?.endpoint, beas);
  assert.equal(await alertsHere("bea"), 0);
});

test("a sign-in that ends while Flash is open keeps this device's wish for alerts; logging out here forgets it", async () => {
  await account("cy");
  storage.clear();
  current = null;
  await signIn("cy");
  render(() => client.usePushSync("cy"));
  await settle();
  await client.turnOnPush("cy", key, t);
  assert.equal(await alertsHere("cy"), 1);

  // The sign-in ends by itself (30 days, or "Log out of all devices" on another device) while
  // Flash is open: its next request gets a 401, and nobody is signed in here.
  await run("DELETE FROM sessions WHERE user_id = 'cy'");
  render(() => client.usePushSync(null));
  await settle();
  assert.equal(current, null, "nothing can arrive while nobody is signed in");
  assert.equal(wanted(), "cy");
  // Signed in again here, alerts are back on by themselves.
  await signIn("cy");
  render(() => client.usePushSync("cy"));
  await settle();
  assert.equal(await alertsHere("cy"), 1);

  // Logging out here on purpose (Flash's signOut) forgets it: signed in again, alerts stay off.
  client.forgetPush("cy");
  render(() => client.usePushSync(null));
  await settle();
  assert.equal(wanted(), "");
  await signIn("cy");
  render(() => client.usePushSync("cy"));
  await settle();
  assert.equal(current, null);
});

test("what the switch says when the browser asks, blocks, or has no push service", async () => {
  await account("dee");
  await signIn("dee");
  const said = async () => {
    try {
      await client.turnOnPush("dee", key, t);
      return "on";
    } catch (e) {
      return (e as Error).message;
    }
  };
  // The browser's question closed without an answer: nothing is blocked, and it will ask again.
  permission.now = "default";
  permission.answer = "default";
  asks = 0;
  assert.equal(await said(), "Allow notifications when your browser asks, then try again.");
  assert.equal(asks, 1);
  permission.answer = "denied";
  assert.equal(await said(), "Notifications are blocked for Flash. Allow them in your browser's site settings, then try again.");
  permission.now = "granted";

  // A browser without a push service (a private window, Brave with push messaging off) says so.
  for (const name of ["AbortError", "NotSupportedError"]) {
    refuse = new DOMException("Registration failed - permission denied", name);
    assert.equal(await said(), "This browser couldn't turn on alerts. Private windows can't get them, and some browsers, like Brave, need push messaging turned on in their settings first.", name);
  }
  refuse = new DOMException("Registration failed - permission denied", "NotAllowedError");
  assert.equal(await said(), "Notifications are blocked for Flash. Allow them in your browser's site settings, then try again.");
  refuse = new Error("no service worker");
  assert.equal(await said(), "Couldn't turn on alerts. Please try again.");
  refuse = null;
  assert.equal(await said(), "on");
});
