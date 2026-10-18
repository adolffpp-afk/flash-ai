import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createECDH, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

/*
 * Alerts when Flash is closed, in the browser (src/lib/push.ts) against Flash's own /api/push: a
 * stand-in browser (its push subscription, notification permission, storage and session cookie) and
 * stand-in push services. The accounts signed in to the browser share its subscription, and turning
 * alerts on when none of them gets alerts by it makes a new one, so no alerts of an account that
 * isn't signed in here follow; a sign-in that ends by itself keeps this device's wish for alerts, and
 * only logging out here forgets it; what the switch says when the browser asks, blocks, or has no
 * push service; and a test alert to an address the push service dropped.
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
let lag = 0; // how long the push service takes to give a new subscription, in ms
type Sub = { endpoint: string; options: { applicationServerKey: ArrayBuffer }; toJSON(): object; unsubscribe(): Promise<boolean> };
let current: Sub | null = null;
// Alerts on the screen, as the service worker showed them: the page each opens names its account (as=).
type Shown = { title: string; data: { url: string }; close(): void };
const tray: Shown[] = [];
function showAlert(title: string, userId?: string) {
  const alert: Shown = {
    title,
    data: { url: `${ORIGIN}/${userId ? `?as=${userId}` : ""}` },
    close: () => {
      const at = tray.indexOf(alert);
      if (at >= 0) tray.splice(at, 1);
    },
  };
  tray.push(alert);
}
const registration = {
  getNotifications: async () => [...tray],
  pushManager: {
    getSubscription: async () => current,
    subscribe: async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
      if (lag) await new Promise((done) => setTimeout(done, lag));
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
  addEventListener() {},
  removeEventListener() {},
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

// The browser's cookies by name (flash_session, and the list of its accounts once it holds two).
const LIST = "__Host-flash_accounts";
const held = () => new Map(cookie.split("; ").filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as [string, string]));
// The browser keeps what it's told to set, and drops what it's told to clear.
function keep(res: Response) {
  const jar = held();
  for (const set of res.headers.getSetCookie()) {
    const [pair] = set.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    if (/Max-Age=0/.test(set)) jar.delete(name);
    else jar.set(name, pair.slice(pair.indexOf("=") + 1));
  }
  cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ---- Flash's server, and the push services ----
const routes: Record<string, unknown> = {
  "/api/push": await import("../src/app/api/push/route.ts"),
  "/api/auth/logout": await import("../src/app/api/auth/logout/route.ts"),
};
const reached: string[] = []; // push addresses an alert was sent to and taken
const dropped = new Set<string>(); // addresses the push service dropped, though the browser still holds them
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/")) {
    // Flash's api() names the tab's account (X-Flash-Account) in the headers it gives.
    const headers = new Headers(init?.headers);
    headers.set("origin", ORIGIN);
    headers.set("cookie", cookie);
    const request = new Request(ORIGIN + url, { method: init?.method ?? "GET", headers, body: init?.body as string | undefined });
    const route = routes[new URL(request.url).pathname] as Record<string, (r: Request) => Promise<Response>>;
    const res = await route[request.method](request);
    keep(res);
    return res;
  }
  if (unsubscribed.has(url) || dropped.has(url)) return new Response(null, { status: 410 });
  reached.push(url);
  return new Response(null, { status: 201 });
}) as typeof fetch;

const client = await import("../src/lib/push.ts");
const { api } = await import("../src/lib/store.ts");
// The account this tab shows, which Flash's requests name (see account-pin.ts).
const { getPin, setPin } = await import("../src/lib/account-pin.ts");
const { render } = (await import(HOOKS)) as { render: (hook: () => void) => void };
const push = await import("../src/lib/server/push.ts");
const { createSession, hashPassword } = await import("../src/lib/server/auth.ts");
const { run, all } = await import("../src/lib/server/db.ts");
const { endAllSessions } = await import("../src/lib/server/account.ts");

// The browser's subscription now (a function, as the code under test changes it).
const subNow = (): Sub | null => current;
const key = push.pushPublicKey()!;
const wanted = () => storage.get("flash:push-accounts") ?? "";
const rowsAt = (endpoint: string) => all<{ user_id: string }>("SELECT user_id FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
async function account(id: string) {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at, language) VALUES (?, ?, ?, 0, 1, '')", [id, `${id}@example.com`, await hashPassword("a password")]);
}
const signIn = async (id: string) => void (cookie = (await createSession(id, true)).split(";")[0]);
/** Signs this browser in to another account as well (Add another account): it's the default now, and the list holds them all. */
async function addAccount(id: string) {
  const token = (await createSession(id, true)).split(";")[0].split("=")[1];
  const before = held();
  const list = before.get(LIST)?.slice(2).split(".") ?? [before.get("flash_session")].filter((t): t is string => Boolean(t));
  cookie = `flash_session=${token}; ${LIST}=1.${[...list, token].join(".")}`;
}
/** Flash's Log out in a tab showing this account (signOut in Flash.tsx): the tab goes on as the next account here, if any. */
async function logOut(id: string) {
  setPin(id);
  const { next } = await api<{ next: { id: string } | null }>("/api/auth/logout", { method: "POST", json: {} });
  await client.logOutHere([id]);
  setPin(next?.id ?? null);
}
/** What reaches this browser now when the account is sent an alert. */
async function alertsHere(userId: string): Promise<number> {
  reached.length = 0;
  await push.sendPush(userId, { title: "Payroll check", body: "Your salary arrived" });
  return reached.filter((url) => url === current?.endpoint).length;
}
// usePushSync's work runs after the render, as an effect's does.
const settle = () => new Promise((done) => setTimeout(done, 100));

test("turning alerts on, or back on, makes a new subscription, so no alerts of an account no longer signed in here follow", async () => {
  await account("ann");
  await account("bea");
  // Bea turns alerts on here; later her sign-in ends by itself, and the page drops the subscription.
  await signIn("bea");
  await client.turnOnPush("bea", key);
  await run("UPDATE sessions SET expires_at = 1 WHERE user_id = 'bea'");
  await client.syncPush(null);
  assert.equal(current, null);
  assert.equal(wanted(), "bea", "still wanted, for when she's back");

  // Ann signs in and turns alerts on here. The browser then loses its cookie (not its subscription),
  // so nothing on the server knows Ann left when Bea signs in again.
  await signIn("ann");
  await client.syncPush("ann");
  await client.turnOnPush("ann", key);
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

  // The switch, too: turning alerts on never reuses a subscription an account no longer signed in here turned on.
  cookie = "";
  await signIn("ann");
  await client.turnOnPush("ann", key);
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
  await client.turnOnPush("cy", key);
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
  await logOut("cy");
  assert.equal(cookie, "", "signed out");
  assert.equal((await all("SELECT 1 FROM sessions WHERE user_id = 'cy'")).length, 0);
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
      await client.turnOnPush("dee", key);
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
  // Blocked, or a private window: Chrome and Edge answer "denied" there themselves, without asking,
  // and nothing can allow them, so the words say that too.
  const blocked = "Notifications are blocked for Flash. Private windows can't show them; in a normal window, allow them in your browser's site settings, then try again.";
  permission.answer = "denied";
  asks = 0;
  assert.equal(await said(), blocked, "the first tap, which asked");
  assert.equal(await said(), blocked, "and every tap after it");
  assert.equal(asks, 2);
  permission.now = "granted";

  // A browser without a push service (a private window, Brave with push messaging off) says so.
  for (const name of ["AbortError", "NotSupportedError"]) {
    refuse = new DOMException("Registration failed - permission denied", name);
    assert.equal(await said(), "This browser couldn't turn on alerts. Private windows can't get them, and some browsers, like Brave, need push messaging turned on in their settings first.", name);
  }
  refuse = new DOMException("Registration failed - permission denied", "NotAllowedError");
  assert.equal(await said(), blocked);
  refuse = new Error("no service worker");
  assert.equal(await said(), "Couldn't turn on alerts. Please try again.");
  refuse = null;
  assert.equal(await said(), "on");
});

test("a test alert to an address the push service dropped says alerts are off here, as the switch then does", async () => {
  await account("eli");
  await signIn("eli");
  await client.turnOnPush("eli", key);
  assert.equal((await client.pushStatus()).on, true);
  // The push service expired this browser's address, which the browser still holds.
  dropped.add(current!.endpoint);
  const said = async () => {
    try {
      await client.sendTestPush();
      return { message: "sent", code: "" };
    } catch (e) {
      return { message: (e as Error).message, code: (e as { code?: string }).code };
    }
  };
  for (const tryNumber of [1, 2]) assert.deepEqual(await said(), { message: "Turn on alerts on this device first.", code: "off" }, `try ${tryNumber}`);
  assert.equal((await client.pushStatus()).on, false);
  // One tap turns them on again, with a new address.
  await client.turnOnPush("eli", key);
  assert.deepEqual(await said(), { message: "sent", code: "" });
});

test("logging out of all devices here forgets this device's wish too", async () => {
  await account("fin");
  storage.clear();
  await signIn("fin");
  await client.turnOnPush("fin", key);
  // Settings already signed every device out, this one included, before Flash's signOut runs.
  await endAllSessions("fin");
  await client.logOutHere(["fin"]);
  assert.equal(wanted(), "");
  await signIn("fin");
  await client.syncPush("fin");
  assert.equal(current, null, "alerts stay off when fin signs in here again");
});

test("alerts still on the screen go when this browser stops being their account's", async () => {
  await account("gus");
  await account("hal");
  storage.clear();
  cookie = "";
  const titles = () => tray.map((n) => n.title);
  await signIn("gus");
  await client.turnOnPush("gus", key);
  showAlert("Gus's weekly money check", "gus");
  // Opening Flash while he's still signed in keeps his.
  await client.syncPush("gus", ["gus"]);
  assert.deepEqual(titles(), ["Gus's weekly money check"]);
  // Logging out here takes them off the screen with the sign-in, so the next person can't read them.
  await logOut("gus");
  assert.deepEqual(titles(), []);
  // So does a sign-in that ended by itself, with nobody signed in here now.
  await signIn("gus");
  showAlert("Gus's weekly money check", "gus");
  showAlert("Flash ∞ AI");
  await client.syncPush(null);
  assert.deepEqual(titles(), []);
  // With Hal signed in here too, each account's stay, whichever account the tab shows.
  showAlert("Gus's weekly money check", "gus");
  showAlert("Hal's invoice check", "hal");
  await addAccount("hal");
  await client.syncPush("hal", ["gus", "hal"]);
  assert.deepEqual(titles(), ["Gus's weekly money check", "Hal's invoice check"]);
  // Only Hal is signed in here now (the browser lost Gus's cookie): Gus's go.
  cookie = "";
  await signIn("hal");
  await client.syncPush("hal", ["hal"]);
  assert.deepEqual(titles(), ["Hal's invoice check"]);
  tray.length = 0;
});

test("every browser on an iPhone or iPad is told to add Flash to the Home Screen, where alerts work", () => {
  const was = { navigator: globalThis.navigator, PushManager: (globalThis as { PushManager?: unknown }).PushManager, Notification: globalThis.Notification };
  const as = (userAgent: string, options: { worker?: boolean; push?: boolean; standalone?: boolean; touch?: number } = {}) => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent, maxTouchPoints: options.touch ?? 5, standalone: options.standalone ?? false, ...(options.worker ? { serviceWorker: was.navigator.serviceWorker } : {}) },
    });
    for (const name of ["PushManager", "Notification"] as const) {
      if (options.push) Object.assign(globalThis, { [name]: was[name] });
      else delete (globalThis as Record<string, unknown>)[name];
    }
    return client.pushSupport();
  };
  const iphone = (browser: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser} Mobile/15E148 Safari/604.1`;
  try {
    // Chrome, Edge and Firefox on an iPhone have no service workers in a tab; Safari has no push in one.
    for (const browser of ["CriOS/141.0.7390.41", "EdgiOS/141.0.3537.71", "FxiOS/143.0"]) assert.equal(as(iphone(browser)), "home-screen", browser);
    assert.equal(as(iphone("Version/18.6"), { worker: true }), "home-screen", "Safari");
    assert.equal(as("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1"), "home-screen", "an iPad");
    // Added to the Home Screen: alerts work there (iOS 16.4 and later).
    assert.equal(as(iphone("Version/18.6"), { worker: true, push: true, standalone: true }), "yes");
    // Before iOS 16.4 even the Home Screen app has none, so the trip there would be for nothing: they're
    // told to update, in a tab and in the app alike, if the device can run it. iOS 15.8 came only to
    // the ones that can't (iPhone 6s, 7 and SE, iPad Air 2 and mini 4), where Software Update finds nothing.
    const settings = readFileSync(new URL("../src/components/Settings.tsx", import.meta.url), "utf8");
    assert.match(settings, /status\.support === "update"\s*\? t\("Alerts need iOS or iPadOS 16\.4 or later\. If this iPhone or iPad can run it, update it to get them\."\)/);
    const old = (os: string, browser: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser} Mobile/15E148 Safari/604.1`;
    assert.equal(as(old("16_1", "Version/16.1"), { worker: true }), "update", "Safari on 16.1");
    assert.equal(as(old("16_1", "Version/16.1"), { worker: true, standalone: true }), "update", "the Home Screen app on 16.1");
    assert.equal(as(old("15_8", "CriOS/141.0.7390.41")), "update", "Chrome on 15.8");
    assert.equal(as(old("16_4", "Version/16.4"), { worker: true }), "home-screen", "Safari on 16.4");
    // An iPad asking for desktop sites says its version only in Safari's Version/.
    assert.equal(as("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15", { worker: true }), "update", "an iPad on 15.6");
    // Anywhere else a browser without them can't get alerts.
    assert.equal(as("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36", { touch: 5 }), "no");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: was.navigator });
    Object.assign(globalThis, { PushManager: was.PushManager, Notification: was.Notification });
  }
});

test("a block says where to allow notifications: the iPhone's Settings in the Home Screen app, the phone's in the Android app", async () => {
  await account("ida");
  await signIn("ida");
  const was = globalThis.navigator;
  // What the alerts switch says, checked against what Response completions' switch says there.
  const said = async (userAgent: string, standalone = false, touch = 5) => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...was, userAgent, maxTouchPoints: touch, standalone } });
    let words = "on";
    try {
      await client.turnOnPush("ida", key);
    } catch (e) {
      words = (e as Error).message;
    }
    assert.equal(client.refusedWords("denied"), words, "Response completions says the same");
    return words;
  };
  // A real block: the browser asks nothing more.
  permission.now = permission.answer = "denied";
  try {
    assert.equal(
      await said("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", true),
      "Notifications are blocked for Flash. Allow them in Settings > Notifications > Flash ∞ AI, then try again.",
    );
    // The Android app opens Flash at /?app=android, and the tab remembers it.
    Object.assign(globalThis, { location: { search: "?app=android" }, sessionStorage: { getItem: () => null, setItem() {} } });
    const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
    assert.equal(await said(android), "Notifications are blocked for Flash. Allow them in Settings > Apps > Flash ∞ AI > Notifications, then try again.");
    // Flash added to the Dock from Safari on a Mac answers for itself, in the Mac's System Settings.
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    Object.assign(globalThis, { matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" }) });
    assert.equal(await said(mac, false, 0), "Notifications are blocked for Flash. Allow them in System Settings > Notifications > Flash ∞ AI, then try again.");
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
    // In a browser it's still that browser's site settings, Safari on a Mac included.
    const browser = "Notifications are blocked for Flash. Private windows can't show them; in a normal window, allow them in your browser's site settings, then try again.";
    assert.equal(await said(mac, false, 0), browser);
    assert.equal(await said(was.userAgent), browser);
    // A question closed without an answer blocks nothing, on either switch.
    assert.equal(client.refusedWords("default"), "Allow notifications when your browser asks, then try again.");
    // Response completions' switch (Settings) takes its words from there.
    const settings = readFileSync(new URL("../src/components/Settings.tsx", import.meta.url), "utf8");
    const toggleNotify = settings.slice(settings.indexOf("async function toggleNotify"), settings.indexOf("async function toggleWake"));
    assert.match(toggleNotify, /else refused\(refusedWords\(allowed\)\);/);
    assert.ok(!/t\("Notifications are blocked|t\("Allow notifications/.test(toggleNotify), "no words of its own");
    // Both switches' words stay in English until shown, so a language picked after shows them in it,
    // and share one line, so a permission one of them gets never leaves the other's refusal behind.
    assert.match(settings, /\{t\(notifySaid\.text\)\}/);
    assert.match(settings, /\{t\(said\.text\)\}/);
    assert.match(settings, /said=\{notifySaid\?\.under === "alerts" \? notifySaid : null\}/);
  } finally {
    permission.now = permission.answer = "granted";
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: was });
  }
});

test("Flash on the screen and in front clears the dot alerts put on its app icon", () => {
  const was = { navigator: globalThis.navigator, document: globalThis.document };
  const heard: Record<string, () => void> = {};
  let clears = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...was.navigator, clearAppBadge: async () => void clears++ } });
  const page = { visibilityState: "visible", addEventListener: (type: string, f: () => void) => void (heard[`page ${type}`] = f), removeEventListener() {} };
  Object.assign(globalThis, { document: page, addEventListener: (type: string, f: () => void) => void (heard[`window ${type}`] = f) });
  try {
    render(() => client.usePushSync(undefined));
    assert.equal(clears, 1, "opening Flash");
    // A window that was on the screen behind another app's is clicked into.
    heard["window focus"]();
    assert.equal(clears, 2);
    page.visibilityState = "hidden";
    heard["page visibilitychange"]();
    assert.equal(clears, 2, "not while it's hidden");
    page.visibilityState = "visible";
    heard["page visibilitychange"]();
    assert.equal(clears, 3);
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: was.navigator });
    Object.assign(globalThis, { document: was.document, addEventListener() {} });
  }
});

test("Settings opened while alerts come back on after a password change shows them on", async () => {
  await account("ivy");
  storage.clear();
  current = null;
  await signIn("ivy");
  await client.turnOnPush("ivy", key);
  // Her password changed here: every sign-in of hers ended with its alerts, and this browser is
  // signed in again. Settings starts turning them back on, without waiting (changePassword).
  await endAllSessions("ivy");
  await signIn("ivy");
  lag = 300;
  const syncing = client.syncPush("ivy");
  // General opened at once, while the push service is still making the new subscription.
  const status = client.pushStatus();
  await syncing;
  lag = 0;
  assert.equal((await status).on, true, "the switch shows what the sync left, not what it found before");
  assert.equal(await alertsHere("ivy"), 1);
});

test("the accounts signed in to one browser share its subscription, and it goes once none of them gets alerts by it", async () => {
  await account("jan");
  await account("kai");
  storage.clear();
  current = null;
  cookie = "";
  await signIn("jan");
  setPin("jan");
  await client.turnOnPush("jan", key);
  const shared = subNow()!.endpoint;
  // Kai is signed in here too, and turns alerts on from his tab: the same subscription, so Jan's still come.
  await addAccount("kai");
  setPin("kai");
  await client.turnOnPush("kai", key);
  assert.equal(subNow()?.endpoint, shared);
  assert.deepEqual([await alertsHere("jan"), await alertsHere("kai")], [1, 1]);
  assert.equal((await client.pushStatus()).on, true, "Kai's switch reads On");
  setPin("jan");
  assert.equal((await client.pushStatus()).on, true, "and so does Jan's");
  // Kai turns his off, and opens Flash again: Jan's still come by it.
  setPin("kai");
  await client.turnOffPush("kai");
  await client.syncPush("kai", ["jan", "kai"]);
  assert.equal(subNow()?.endpoint, shared);
  assert.deepEqual([await alertsHere("jan"), await alertsHere("kai")], [1, 0]);
  assert.equal((await client.pushStatus()).on, false);
  // Jan turns hers off too: nobody here gets alerts by it now, so it goes.
  setPin("jan");
  await client.turnOffPush("jan");
  assert.equal(current, null);
  setPin(null);
});

test("logging one account out here keeps the other's alerts; logging out the last, or all of them, drops the subscription", async () => {
  const titles = () => tray.map((n) => n.title);
  for (const how of ["one by one", "all at once"]) {
    const [lin, mia] = [`lin${how.length}`, `mia${how.length}`];
    await account(lin);
    await account(mia);
    storage.clear();
    current = null;
    cookie = "";
    await signIn(lin);
    setPin(lin);
    await client.turnOnPush(lin, key);
    await addAccount(mia);
    setPin(mia);
    await client.turnOnPush(mia, key);
    showAlert("Lin's payroll check", lin);
    showAlert("Mia's weekly summary", mia);
    if (how === "one by one") {
      // Lin logs out from her tab, which goes on as Mia.
      await logOut(lin);
      assert.equal(getPin(), mia);
      await client.syncPush(mia, [mia]);
      assert.deepEqual(titles(), ["Mia's weekly summary"]);
      assert.deepEqual([await alertsHere(lin), await alertsHere(mia)], [0, 1]);
      assert.equal(wanted(), mia);
      // Mia logs out too: nobody is signed in here.
      await logOut(mia);
    } else {
      // Log out of all accounts (signOutAll in Flash.tsx).
      await api("/api/auth/logout", { method: "POST", json: { all: true } });
      await client.logOutHere([lin, mia]);
      setPin(null);
    }
    assert.equal(cookie, "", how);
    await client.syncPush(null);
    assert.deepEqual(titles(), [], how);
    assert.equal(current, null, how);
    assert.equal(wanted(), "", `${how}: neither wants them when signed in here again`);
  }
  // Flash's own log outs do this (signOut and signOutAll), and leave the account in an alert's page
  // (as=) to the account switcher, which opens the tab as it (adoptAccountFromUrl).
  const flash = readFileSync(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.match(flash, /usePushSync\(signedOut \? null : me\?\.user\.id, me\?\.accounts\.map\(\(a\) => a\.id\)\)/);
  const signOut = flash.slice(flash.indexOf("async function signOut("), flash.indexOf("async function signOutAll("));
  assert.match(signOut, /logOutHere\(\[gone\]\)/);
  assert.match(flash.slice(flash.indexOf("async function signOutAll(")), /logOutHere\(\(me\?\.accounts \?\? \[\]\)\.map\(\(a\) => a\.id\)\)/);
  assert.ok(!flash.includes('params.delete("as")'));
});
