import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * The browser side of several accounts in one browser (see account-pin.ts): the account a tab
 * shows, how its requests and links name it, and that nothing breaks when storage refuses.
 * The browser is a stand-in: sessionStorage, history and fetch.
 */

class MemoryStorage {
  data = new Map<string, string>();
  refuse = false;
  getItem(key: string) {
    if (this.refuse) throw new Error("SecurityError");
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.refuse) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string) {
    if (this.refuse) throw new Error("SecurityError");
    this.data.delete(key);
  }
}

const storage = new MemoryStorage();
// The events the page is sent (flash:account-check).
const events: string[] = [];
let address = "https://flash-app.test/";
const g = globalThis as Record<string, unknown>;
g.sessionStorage = storage;
// Not a browser with tabs to tell (and a real channel would keep the test running).
g.BroadcastChannel = undefined;
g.window = {
  get location() {
    const url = new URL(address);
    return { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash };
  },
  history: {
    state: null,
    replaceState: (_state: unknown, _title: string, to: string) => {
      address = new URL(to, address).href;
    },
  },
  dispatchEvent: (event: Event) => {
    events.push(event.type);
    return true;
  },
};
type Sent = { url: string; method: string; headers: Headers; body: unknown };
const sent: Sent[] = [];
let accountsAnswer: { default: string | null } = { default: null };
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  sent.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
  if (url === "/api/auth/accounts") return Response.json(accountsAnswer);
  // What the server says to a tab whose account isn't signed in here, and another refusal.
  if (url === "/api/chat") return Response.json({ error: "Please sign in.", code: "signed_out" }, { status: 401 });
  if (url === "/api/connect/x") return Response.json({ error: "Reconnect.", code: "reconnect" }, { status: 401 });
  return Response.json({ ok: true });
}) as typeof fetch;

const pin = await import("../src/lib/account-pin.ts");
const store = await import("../src/lib/store.ts");
const { isLocalPath } = await import("../src/lib/local-path.ts");

test("api() keeps the caller's headers, adds the JSON type and names the tab's account", async () => {
  pin.setPin("acct_a");
  sent.length = 0;
  await store.api("/api/projects/p1", { method: "PUT", headers: { "X-Extra": "1" }, json: { name: "x" } });
  const [put] = sent;
  assert.equal(put.headers.get("x-extra"), "1", "the caller's header isn't dropped any more");
  assert.equal(put.headers.get("content-type"), "application/json");
  assert.equal(put.headers.get("x-flash-account"), "acct_a");
  assert.equal(put.body, JSON.stringify({ name: "x" }));
  // A picture's link on another site never hears which account a tab shows.
  sent.length = 0;
  await store.authedFetch("https://cdn.example/picture.png");
  assert.equal(sent[0].headers.get("x-flash-account"), null);
  await store.authedFetch("https://flash-app.test/api/files/f1");
  assert.equal(sent[1].headers.get("x-flash-account"), "acct_a");
  await store.authedFetch("//evil.example/x");
  assert.equal(sent[2].headers.get("x-flash-account"), null);
});

test("a tab with no account takes the browser's default before its first change, once", async () => {
  pin.setPin(null);
  accountsAnswer = { default: "acct_d" };
  sent.length = 0;
  await store.api("/api/projects", { method: "GET" });
  assert.deepEqual(sent.map((s) => s.url), ["/api/projects"], "reads don't ask");
  assert.equal(sent[0].headers.get("x-flash-account"), null);
  await store.api("/api/me", { method: "PATCH", json: {} });
  assert.deepEqual(sent.map((s) => s.url), ["/api/projects", "/api/auth/accounts", "/api/me"]);
  assert.equal(sent[2].headers.get("x-flash-account"), "acct_d");
  assert.equal(pin.getPin(), "acct_d");
});

test("withAccount adds the tab's account to a link once, before its #", () => {
  pin.setPin("acct_a");
  assert.equal(pin.withAccount("/api/sites/s1/orders"), "/api/sites/s1/orders?as=acct_a");
  assert.equal(pin.withAccount("/api/sites/s1/members?format=csv"), "/api/sites/s1/members?format=csv&as=acct_a");
  assert.equal(pin.withAccount("/api/sites/s1/versions?view=v1#top"), "/api/sites/s1/versions?view=v1&as=acct_a#top");
  assert.equal(pin.withAccount(pin.withAccount("/api/sites/s1/orders")), "/api/sites/s1/orders?as=acct_a", "once");
  pin.setPin(null);
  assert.equal(pin.withAccount("/api/sites/s1/orders"), "/api/sites/s1/orders");
});

test("an address's ?as= becomes the tab's account and leaves the address; a malformed one is ignored", () => {
  pin.setPin("acct_a");
  address = "https://flash-app.test/?apps=1&as=acct_b#x";
  assert.equal(pin.adoptAccountFromUrl(), "acct_b");
  assert.equal(pin.getPin(), "acct_b");
  assert.equal(address, "https://flash-app.test/?apps=1#x");
  assert.equal(storage.data.get("flash-account"), "acct_b", "kept for reloads of this tab");
  address = "https://flash-app.test/?as=bad%20id!";
  assert.equal(pin.adoptAccountFromUrl(), null);
  assert.equal(pin.getPin(), "acct_b", "unchanged");
  assert.equal(address, "https://flash-app.test/");
  address = "https://flash-app.test/?credits=1";
  assert.equal(pin.adoptAccountFromUrl(), null);
  assert.equal(address, "https://flash-app.test/?credits=1");
  assert.equal(pin.setPin("not ok!"), undefined);
  assert.equal(pin.getPin(), null, "only an id is kept");
});

test("storage that refuses keeps the account for this page, without breaking anything", async () => {
  storage.refuse = true;
  pin.setPin("acct_c");
  assert.equal(pin.getPin(), "acct_c");
  assert.deepEqual(pin.accountHeaders(), { "X-Flash-Account": "acct_c" });
  sent.length = 0;
  await store.api("/api/me", { method: "PATCH", json: {} });
  assert.equal(sent[0].headers.get("x-flash-account"), "acct_c");
  pin.setPin(null);
  assert.deepEqual(pin.accountHeaders(), {});
  storage.refuse = false;
  assert.equal(pin.isolate("a@b.co"), "⁨a@b.co⁩");
  // No BroadcastChannel here: announcing reaches nobody and listening does nothing.
  pin.announce({ type: "changed" });
  pin.onAnnounce(() => assert.fail("nothing to hear"))();
});

test("a link's ?next= (Add another account) is followed only to a path on Flash", async () => {
  // Browsers drop tabs and line breaks from an address, so "/\t/evil.example" goes to evil.example.
  for (const bad of ["/\t/evil.example/signin", "/\n/evil.example", "/\r/evil.example", "//evil.example", "/\\evil.example", "/a\\b", "https://evil.example", "evil", "", null]) {
    assert.equal(isLocalPath(bad), false, JSON.stringify(bad));
  }
  assert.equal(isLocalPath("/oauth/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"), true);
  // Whatever one character follows the first "/", an address that passes stays on Flash.
  for (let code = 0; code < 128; code++) {
    const next = `/${String.fromCharCode(code)}/evil.example/x`;
    if (isLocalPath(next)) assert.equal(new URL(next, "https://flash-app.test/?add=1").origin, "https://flash-app.test", JSON.stringify(next));
  }
  // The page reads ?next= only through it.
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.match(page, /const back = opened\.get\("next"\);\n\s*const safeNext = isLocalPath\(back\) \? back : undefined;/);
});

test("a tab remembers its account's email through a reload, to say which one was logged out", async () => {
  pin.setPin("acct_e");
  pin.setPinEmail("e@x.io");
  assert.equal(pin.getPinEmail(), "e@x.io");
  // The page again after a reload: a fresh copy of the module, the same tab's storage.
  const reloaded = (await import(new URL("../src/lib/account-pin.ts?reload", import.meta.url).href)) as typeof pin;
  assert.equal(reloaded.getPin(), "acct_e");
  assert.equal(reloaded.getPinEmail(), "e@x.io");
  // Showing another account, or none, forgets it.
  pin.setPin("acct_f");
  assert.equal(pin.getPinEmail(), "");
  assert.equal(storage.data.has("flash-account-email"), false);
  pin.setPinEmail("f@x.io");
  pin.setPin(null);
  assert.equal(pin.getPinEmail(), "");
  pin.setPinEmail("nobody@x.io");
  assert.equal(pin.getPinEmail(), "", "no account shown, nothing kept");
  // Storage that refuses keeps it for this page.
  storage.refuse = true;
  pin.setPin("acct_g");
  pin.setPinEmail("g@x.io");
  assert.equal(pin.getPinEmail(), "g@x.io");
  storage.refuse = false;
  pin.setPin(null);
});

test("a 401 saying the tab is signed out makes Flash check who is still signed in here, for chat and every api() call", async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  pin.setPin("acct_h");
  events.length = 0;
  const res = await store.authedFetch("/api/chat", { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Please sign in.", code: "signed_out" }, "the caller still reads the answer");
  await settle();
  assert.deepEqual(events, ["flash:account-check"]);
  events.length = 0;
  await assert.rejects(store.api("/api/chat", { method: "POST", json: {} }), { status: 401, code: "signed_out" });
  await settle();
  assert.deepEqual(events, ["flash:account-check"]);
  // Any other 401 (a connected account to sign in to again) isn't about this browser's accounts.
  events.length = 0;
  await assert.rejects(store.api("/api/connect/x"), { status: 401, code: "reconnect" });
  await settle();
  assert.deepEqual(events, []);
  // A tab with no account yet has nothing to check: the page shows sign in itself.
  pin.setPin(null);
  accountsAnswer = { default: null };
  await store.authedFetch("/api/chat");
  await settle();
  assert.deepEqual(events, []);
});

test("an answer asked for before the tab moved to another account can't move it back", async () => {
  // A tab with no account yet takes whichever the server answered (the browser's default).
  pin.setPin(null);
  assert.equal(pin.isTabAccount("acct_a"), true);
  pin.setPin("acct_a");
  assert.equal(pin.isTabAccount("acct_a"), true);
  // Switch account: the tab moves to b and reloads, while a reply's refresh for a is still out.
  pin.setPin("acct_b");
  assert.equal(pin.isTabAccount("acct_a"), false, "a's late answer is left alone");
  assert.equal(pin.isTabAccount("acct_b"), true);
  // The page takes the account's data only through adoptMe, which asks first.
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.match(page, /async function adoptMe\(fetched: Me\): Promise<Me \| null> \{\n(\s*\/\/.*\n)*\s*if \(!isTabAccount\(fetched\.account\)\) return null;/);
  assert.equal(page.match(/setMe\(data\)/g)?.length, 1);
  pin.setPin(null);
});

test("a link for an account remembers where it was going, for after signing in to that account", async () => {
  address = "https://flash-app.test/?apps=1&as=acct_l#x";
  assert.equal(pin.adoptAccountFromUrl(), "acct_l");
  assert.equal(pin.linkTarget(), "/?apps=1", "without as= or the #");
  address = "https://flash-app.test/?credits=1&as=acct_m";
  pin.adoptAccountFromUrl();
  assert.equal(pin.linkTarget(), "/?credits=1");
  // The chooser's "Use another account" goes on to it once signed in, only from a link's chooser.
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.match(page, /const target = from\.reason === "link" \? linkTarget\(\) : null;/);
  assert.match(page, /setAdding\(\{ back: from, next: target && isLocalPath\(target\) \? target : undefined \}\);/);
  assert.equal(page.match(/onAdd=\{\(\) => addFromChooser\(chooser\)\}/g)?.length, 2, "both of the chooser's places");
  assert.match(page, /window\.location\.replace\(adding\.next \|\| "\/"\);/);
  pin.setPin(null);
  address = "https://flash-app.test/";
});
