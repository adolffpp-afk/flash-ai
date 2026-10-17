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
// The browser's localStorage, which every tab shares.
const browserStorage = new MemoryStorage();
// The events the page is sent (flash:account-check).
const events: string[] = [];
let address = "https://flash-app.test/";
// Where the page was sent with location.replace (a switch's reload).
const replaced: string[] = [];
const g = globalThis as Record<string, unknown>;
g.sessionStorage = storage;
g.localStorage = browserStorage;
// Not a browser with tabs to tell (and a real channel would keep the test running).
g.BroadcastChannel = undefined;
g.window = {
  get location() {
    const url = new URL(address);
    return {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: (to: string) => void replaced.push(to),
    };
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
  assert.match(page, /openAdding\(\{ back: from, next: target && isLocalPath\(target\) \? target : undefined \}\);/);
  assert.equal(page.match(/onAdd=\{\(\) => addFromChooser\(chooser\)\}/g)?.length, 2, "both of the chooser's places");
  assert.match(body(page, "async function addDone("), /goOnAs\(id, from\.next\);/);
  pin.setPin(null);
  address = "https://flash-app.test/";
});

/** The body of a function in a page's source, from its name to its closing brace. */
function body(source: string, start: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `${start} is in the page`);
  let depth = 0;
  for (let i = source.indexOf("{", source.indexOf(")", at)); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`${start} never closes`);
}

test("a switch names the account chosen only once the page loads, so a reload the browser keeps from happening leaves the tab on its account", async () => {
  pin.setPin("acct_a");
  const to = pin.switchAddress("acct_b");
  assert.equal(to, "/?as=acct_b&switched=1");
  // Switch (and the next account after a log out) reloads through reloadAs, which names nobody:
  // if "Leave site?" keeps this page (Stay), its requests still name the account it shows.
  replaced.length = 0;
  pin.reloadAs("acct_b", { email: "a@x.io", next: "b@x.io" });
  assert.deepEqual(replaced, [to]);
  assert.equal(pin.getPin(), "acct_a", "until the page loads, this tab's requests name the account it shows");
  assert.equal(new Headers(pin.accountHeaders()).get("x-flash-account"), "acct_a");
  // The new page: it shows the account chosen, and no link waits on it (no "This link is for another account").
  address = `https://flash-app.test${to}`;
  assert.equal(pin.adoptAccountFromUrl(), null);
  assert.equal(pin.getPin(), "acct_b");
  assert.equal(address, "https://flash-app.test/", "the address loses both");
  // It says who was logged out and who it uses now, once.
  assert.deepEqual(pin.takeLeftNote(), { email: "a@x.io", next: "b@x.io" });
  assert.equal(pin.takeLeftNote(), null);
  pin.reloadAs("acct_c");
  assert.equal(pin.takeLeftNote(), null, "a switch leaves no note");
  storage.refuse = true;
  pin.reloadAs("acct_c", { email: "a@x.io", next: "c@x.io" });
  assert.equal(pin.takeLeftNote(), null, "storage that refuses: no note, and nothing breaks");
  storage.refuse = false;
  // After Add another account, the page of Flash it was for opens as the account signed in to, named
  // only once that page loads, and always as a page load: a link differing only by its # too.
  assert.equal(pin.switchAddress("acct_b", "/?apps=1"), "/?apps=1&as=acct_b&switched=1");
  assert.equal(pin.switchAddress("acct_b", "/?as=acct_x&apps=1"), "/?as=acct_b&apps=1&switched=1", "a link's own as= doesn't win");
  pin.setPin("acct_a");
  address = "https://flash-app.test/";
  replaced.length = 0;
  pin.reloadAs("acct_d", undefined, "/#done");
  assert.deepEqual(replaced, ["/?as=acct_d&switched=1#done"]);
  assert.notEqual(new URL(replaced[0], address).search, new URL(address).search, "not the same page: it loads");
  assert.equal(pin.getPin(), "acct_a", "until it loads, the tab names the account it shows");
  address = new URL(replaced[0], address).href;
  assert.equal(pin.adoptAccountFromUrl(), null);
  assert.equal(pin.getPin(), "acct_d");
  assert.equal(address, "https://flash-app.test/#done");
  address = "https://flash-app.test/";
  pin.setPin("acct_a");
  // Flash names nobody on the way: no setPin in Switch, nor in a log out before it reloads as the
  // next account; they reload only through reloadAs. A page's check puts its requests back on the
  // account it shows if they ever name another.
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /function reloadAs\(|location\.replace\(switchAddress/, "one reloadAs, account-pin's");
  const switching = body(page, "async function switchAccount(");
  assert.doesNotMatch(switching, /setPin\(/);
  assert.match(switching, /\n\s+reloadAs\(id\);/);
  const signingOut = body(page, "async function signOut(");
  const reloads = signingOut.indexOf("reloadAs(next.id, ");
  assert.ok(reloads > 0, "a log out goes on as the next account through reloadAs");
  assert.doesNotMatch(signingOut.slice(0, reloads), /setPin\(/);
  assert.equal(page.match(/reloadAs\(/g)?.length, 3, "Switch, log out and Add another account, nothing else");
  // Add another account names the account signed in to only through reloadAs too, after saving
  // what changed here (or asking), as a switch does; Connect to Flash's own page shows the default.
  const added = body(page, "async function addDone(");
  assert.doesNotMatch(added, /setPin\(/);
  assert.doesNotMatch(added, /location\.(replace|assign)\(/);
  assert.match(added, /const saved = !meRef\.current \|\| Boolean\(from\.back\) \|\| \(await flushSaves\(\)\);\n\s+if \(stayed\(\)\) return;\n\s+if \(!saved\) \{\n(\s*\/\/.*\n)*\s+closeAdding\(\);\n\s+setUnsaved\(\{ go: \(\) => goOnAs\(id, from\.next\), added: true \}\);\n\s+return;\n\s+\}\n\s+goOnAs\(id, from\.next\);/);
  assert.match(body(page, "function goOnAs("), /if \(to && new URL\(to, window\.location\.href\)\.pathname !== "\/"\) return window\.location\.replace\(to\);\n\s+reloadAs\(id, undefined, to\);/);
  assert.match(page, /onDone=\{\(result\) => addDone\(adding, result\)\}/);
  assert.match(page, /onSwitch=\{unsaved\.go\}/);
  // The form stays busy while that happens.
  const screen = await readFile(new URL("../src/components/AuthScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /\n\s+await onDone\(result\);\n/);
  assert.match(page, /if \(mine && showing && mine !== showing\.id\) \{\n\s+setPin\(showing\.id\);/);
  // The note "Logged out of …" shows only on the account it says the tab went on as.
  assert.match(page, /if \(left && left\.next === data\.user\.email\) setNotice\(/);
  pin.setPin(null);
});

test("a password sign-in sends the page to open after it, so two-step sign-in from a link's chooser opens that page", async () => {
  const { signInBody } = await import("../src/lib/accounts.ts");
  const fields = { name: "", email: "a@x.io", password: "pw-12345678" };
  assert.deepEqual(signInBody("login", { ...fields, next: "/?apps=1" }), { ...fields, next: "/?apps=1" });
  assert.deepEqual(signInBody("login", fields), fields, "none to open: none sent");
  assert.deepEqual(signInBody("login", { ...fields, next: "" }), fields);
  assert.deepEqual(signInBody("signup", { ...fields, name: "Ana", next: "/?apps=1" }), { ...fields, name: "Ana" }, "a new account has no two-step sign-in");
  // The screen sends exactly that, with the next it was given.
  const { readFile } = await import("node:fs/promises");
  const screen = await readFile(new URL("../src/components/AuthScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /api<[^>]+>\(`\/api\/auth\/\$\{mode\}`, \{\n\s+method: "POST",\n(\s*\/\/.*\n)*\s+json: signInBody\(mode, \{ name, email, password, next \}\),/);
});

test("an invitation for another account signed in here waits in its tab only, and is joined there once it switches", async () => {
  const invite = await import("../src/lib/invite-keep.ts");
  // Opened before an account loaded: kept for the browser.
  invite.saveInvite("tok_1");
  assert.equal(browserStorage.data.get("flash_invite"), "tok_1");
  assert.equal(invite.waitingInvite(), "tok_1");
  // The server said it is for another account here: this tab only, so no other tab or account asks too.
  invite.keepInviteInTab("tok_1");
  assert.equal(browserStorage.data.has("flash_invite"), false);
  assert.equal(storage.data.get("flash_invite"), "tok_1");
  const otherTab = new MemoryStorage();
  g.sessionStorage = otherTab;
  assert.equal(invite.waitingInvite(), null, "another tab has nothing to join");
  g.sessionStorage = storage;
  // This tab, reloaded as that account (the switch): the tab's copy is the one joined, first.
  browserStorage.data.set("flash_invite", "tok_2");
  assert.equal(invite.waitingInvite(), "tok_1");
  invite.forgetInvite();
  assert.equal(storage.data.has("flash_invite"), false);
  assert.equal(browserStorage.data.has("flash_invite"), false);
  assert.equal(invite.waitingInvite(), null);
  // Storage that refuses keeps nothing, and breaks nothing.
  storage.refuse = browserStorage.refuse = true;
  invite.saveInvite("tok_3");
  invite.keepInviteInTab("tok_3");
  assert.equal(invite.waitingInvite(), null);
  invite.forgetInvite();
  storage.refuse = browserStorage.refuse = false;
  // The page keeps invitations only through these.
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /flash_invite|INVITE_KEY/);
  const accept = body(page, "async function acceptInvite(");
  assert.match(accept, /const token = waitingInvite\(\);/);
  assert.match(accept, /if \(code === "other_account" && data\?\.forAccount\) \{\n\s+keepInviteInTab\(token\);\n\s+return setInviteFor\(data\.forAccount\);/);
  assert.match(page, /if \(invite\) \{\n\s+saveInvite\(invite\);/);
});

test("each account keeps its badge colour while it stays signed in here, whoever logs out or is added", async () => {
  const { keepTones, accountTones } = await import("../src/lib/account-tones.ts");
  const tones = (saved: [string, number][], ids: string[]) => Object.fromEntries(keepTones(saved, ids, 5));
  // Added in the order Ben, Ana, Hana: the first keeps Flash's own.
  let kept = keepTones([], ["ben", "ana", "hana"], 5);
  assert.deepEqual(Object.fromEntries(kept), { ben: 0, ana: 1, hana: 2 });
  // Ben logs out: Ana and Hana keep theirs (a tab on Ana is never shown Hana's colour, or the reverse).
  kept = keepTones(kept, ["ana", "hana"], 5);
  assert.equal(Object.fromEntries(kept).ana, 1);
  assert.equal(Object.fromEntries(kept).hana, 2);
  // Someone new takes a colour nobody here has had, so a tab still showing Ben (not refreshed yet) isn't mixed up with them.
  kept = keepTones(kept, ["ana", "hana", "dev"], 5);
  assert.deepEqual(tones(kept, ["ana", "hana", "dev"]), { ana: 1, hana: 2, dev: 3, ben: 0 });
  // A list another tab hasn't refreshed yet changes nobody's colour.
  assert.deepEqual(tones(kept, ["ben", "ana", "hana"]), { ben: 0, ana: 1, hana: 2, dev: 3 });
  // Once every colour has been had, the next account takes the one of an account that isn't here anymore.
  kept = keepTones(kept, ["ana", "hana", "dev", "eve"], 5);
  kept = keepTones(kept, ["ana", "hana", "dev", "eve", "fay"], 5);
  const now = Object.fromEntries(kept);
  assert.deepEqual([now.ana, now.hana, now.dev, now.eve, now.fay], [1, 2, 3, 4, 0]);
  assert.equal(now.ben, undefined, "Ben's colour went to Fay");
  // Five accounts, five colours: all different.
  assert.equal(new Set(Object.values(now)).size, 5);
  // Whatever storage holds, colours stay valid and apart.
  assert.deepEqual(tones([["a", 7], ["b", 1], ["c", 1], ["bad id!", 2], ["d", -1], ["e", 1.5]], ["a", "b", "c"]), { b: 1, a: 0, c: 2 });
  // Kept in localStorage, which all of this browser's tabs share; storage that refuses keeps them for this page.
  browserStorage.data.clear();
  // Alone on a browser that never held two accounts: Flash's own colour, and nothing kept yet.
  assert.deepEqual([...accountTones(["solo"], 5)], [["solo", 0]]);
  assert.equal(browserStorage.data.get("flash-account-tones"), undefined);
  assert.deepEqual([...accountTones(["x", "y"], 5)], [["x", 0], ["y", 1]]);
  assert.deepEqual(JSON.parse(browserStorage.data.get("flash-account-tones")!), [["x", 0], ["y", 1]]);
  assert.deepEqual([...accountTones(["y"], 5)], [["y", 1], ["x", 0]]);
  browserStorage.refuse = true;
  assert.deepEqual([...accountTones(["y", "z"], 5)].sort(), [["x", 0], ["y", 1], ["z", 2]]);
  browserStorage.refuse = false;
  // Work (added first) and personal: once work logs out, personal keeps its colour, and isn't
  // shown in work's (which a tab still on work, not refreshed yet, shows).
  const both = accountTones(["work", "personal"], 5);
  assert.notEqual(both.get("personal"), both.get("work"));
  assert.equal(accountTones(["personal"], 5).get("personal"), both.get("personal"));
  assert.equal(accountTones(["personal", "new"], 5).get("personal"), both.get("personal"), "nor when another is added");
  browserStorage.data.clear();
  // A shared computer: Ben and Ana used this browser, then logged out of all accounts. The next
  // person, alone here, has Flash's own colour, as on a fresh browser, and the old colours are let go.
  accountTones(["ben", "ana"], 5);
  assert.deepEqual([...accountTones(["gil"], 5)], [["gil", 0]]);
  assert.equal(browserStorage.data.get("flash-account-tones"), undefined);
  assert.deepEqual([...accountTones(["gil", "hana"], 5)], [["gil", 0], ["hana", 1]]);
  browserStorage.refuse = true;
  accountTones(["kim", "lee"], 5);
  assert.deepEqual([...accountTones(["max"], 5)], [["max", 0]], "storage that refuses too");
  browserStorage.refuse = false;
  browserStorage.data.clear();
  // The menu and the account chooser colour every badge this way, one account left included.
  const { readFile } = await import("node:fs/promises");
  const menu = await readFile(new URL("../src/components/AccountMenu.tsx", import.meta.url), "utf8");
  assert.match(menu, /const at = accounts\?\.length \? accountTones\(accounts\.map\(\(a\) => a\.id\), TONES\.length\)\.get\(id\) : 0;/);
  assert.doesNotMatch(menu, /findIndex/);
});

test("before a tab leaves its account, Flash waits for the saves already under way, which the reload would cancel", async () => {
  const { saveTracker } = await import("../src/lib/save-tracker.ts");
  const saving = saveTracker();
  assert.equal(await saving.settled(20), true, "nothing under way");
  // A chat's save still uploading (a slow phone): not kept yet, so the switch asks first.
  let finish!: (kept: boolean) => void;
  const upload = saving.track(new Promise<boolean>((resolve) => (finish = resolve)));
  assert.equal(await saving.settled(20), false);
  // Once it is kept, nothing waits; one that failed says so, once.
  setTimeout(() => finish(true), 5);
  assert.equal(await saving.settled(500), true);
  assert.equal(await upload, true);
  void saving.track(Promise.resolve(false));
  assert.equal(await saving.settled(50), false);
  assert.equal(await saving.settled(50), true, "an ended save isn't waited on again");
  void saving.track(Promise.reject(new Error("offline")));
  assert.equal(await saving.settled(50), false);
  // Every save the page makes is counted: chats, pins, names and the preferences.
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  const saves = [...page.matchAll(/api\([^)]*\{ method: "(?:PUT|PATCH|POST|DELETE)"/g)].filter((m) => /\/api\/projects\/\$\{id\}`|"\/api\/me"/.test(m[0]) && !/DELETE/.test(m[0]));
  assert.equal(saves.length, 5);
  for (const m of saves) assert.match(page.slice(m.index - 30, m.index), /saving\.track\(\s*$/, m[0]);
  const flush = body(page, "async function flushSaves(");
  assert.match(flush, /const kept = await saving\.settled\(3000\);\n\s+return kept && dirtyRef\.current\.size === 0 && !hasCodeDraft\(\);/);
});

test("code changed in a Code view and not saved yet makes a switch ask first", async () => {
  const drafts = await import("../src/lib/code-drafts.ts");
  assert.equal(drafts.hasCodeDraft(), false);
  drafts.markCodeDraft(":r1:", true);
  drafts.markCodeDraft(":r2:", true);
  drafts.markCodeDraft(":r1:", false);
  assert.equal(drafts.hasCodeDraft(), true, "one editor still holds some");
  drafts.markCodeDraft(":r2:", false);
  assert.equal(drafts.hasCodeDraft(), false);
  // Each editor says so while its code differs from the app's, and stops once it closes.
  const { readFile } = await import("node:fs/promises");
  const preview = await readFile(new URL("../src/components/AppPreview.tsx", import.meta.url), "utf8");
  const editor = body(preview, "function CodeEditor(");
  assert.match(editor, /const unsaved = changed && Boolean\(onSave\);\n\s+useEffect\(\(\) => \{\n\s+markCodeDraft\(editor, unsaved\);\n\s+return \(\) => markCodeDraft\(editor, false\);\n\s+\}, \[editor, unsaved\]\);/);
  // Switch asks ("Switch anyway?") when flushSaves says something isn't saved.
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  assert.match(body(page, "async function switchAccount("), /if \(!gone && !anyway && !\(await flushSaves\(\)\)\) \{\n\s+setUnsaved\(\{ go: \(\) => void switchAccount\(id, \{ anyway: true \}\) \}\);/);
  assert.match(page, /<SwitchAnyway\n\s+onSwitch=\{unsaved\.go\}/);
});

test("the page around a switch: what Flash says stays in view, the menu closes when the tab stays, and add mode keeps the page", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  const menu = await readFile(new URL("../src/components/AccountMenu.tsx", import.meta.url), "utf8");
  // What Flash says shows above the chat, which scrolls under it (a long chat opens at its bottom),
  // or above the preview on a phone's Preview tab: never inside the chat's scroller.
  const said = page.indexOf("        {said && (\n");
  const scroller = page.indexOf('className={`min-h-0 flex-1 overflow-y-auto ${tab === "preview" ? "invisible" : ""}');
  assert.ok(said > 0 && scroller > said, "said comes before the chat's scroller");
  // It never takes the chat's room on a screen with little height (a phone held sideways, with a
  // notice and an invitation): it shares a grid with the chat (or the preview) and takes at most
  // half of it, then scrolls on its own, its edge faded.
  assert.match(page.slice(said - 400, said), /\n\s+<div className="grid min-h-0 flex-1 grid-rows-\[fit-content\(50%\)_minmax\(0,1fr\)\]">\n$/);
  assert.match(page.slice(said, scroller), /^\s+\{said && \(\n\s+<div className=\{`mx-auto w-full overflow-y-auto overscroll-contain \[mask-image:linear-gradient\(to_bottom,#000_calc\(100%-0\.5rem\),transparent\)\] \$\{tab === "preview" \? "[^"]+ pb-2" : `[^`]+ pb-2 [^`]+`\}`\}>\{said\}<\/div>\n\s+\)\}\n\s+<div className="relative row-start-2 flex min-h-0 flex-col">\n/);
  assert.doesNotMatch(page.slice(said, scroller), /shrink-0/);
  assert.equal(page.match(/\{said\}/g)?.length, 1, "shown in one place");
  assert.match(page, /\{\(!me\.verified \|\| allOff\) && \(/);
  assert.equal(page.match(/role="status"/g)?.length, 3, "the notice, the invitation and the break note, each once");
  // A switch that doesn't happen (it asks first, or fails and says why) closes the menu, so that shows.
  assert.match(menu, /void onSwitch\(a\.id\)\.then\(\(reloading\) => reloading \|\| close\(\)\);/);
  assert.match(page, /onSwitch=\{\(id\) => switchAccount\(id\)\}/);
  const switching = body(page, "async function switchAccount(");
  assert.equal(switching.match(/return false;/g)?.length, 3);
  assert.match(switching, /reloadAs\(id\);[\s\S]*return true;\n\s+\}$/);
  // The browser tab's title names the tab's account only while it is signed in here.
  assert.match(page, /const tabEmail = me && !chooser && \(me\.accounts\?\.length \?\? 0\) > 1 \? me\.user\.email : null;/);
  // Add another account shows over the page, which stays as it was (unsaved code, the running app,
  // Ask Flash), out of reach until Back; only before an account has loaded is it the whole page.
  assert.match(page, /if \(addScreen && !me\) return addScreen;/);
  assert.match(page, /<div className="flex h-full" inert=\{Boolean\(addScreen\)\}>/);
  assert.match(page, /\{addScreen && adding && \(\n\s+<AddOver label=\{adding\.again \? t\("Welcome back"\) : t\("Add another account"\)\} onBack=\{\(\) => addBack\(adding\)\}>\n\s+\{addScreen\}\n\s+<\/AddOver>/);
  // Signing in again from the chooser to the account this tab showed goes on where it was.
  assert.equal(page.match(/again=\{chooser\.reason === "gone" && chooser\.email \? \{ email: chooser\.email, name: chooser\.name, onChoose: \(\) => signInAgain\(chooser\) \} : undefined\}/g)?.length, 2);
  assert.match(body(page, "async function addDone("), /if \(from\.again && id && id === getPin\(\)\) \{\n\s+closeAdding\(\);\n\s+if \(meRef\.current\) void refreshMe\(\);\n\s+else void start\(\);\n\s+return;\n\s+\}/);
});

test("Add another account over the page: nothing under it listens on, and it is a dialog the keyboard can use", async () => {
  // The mic is stopped for whoever holds it: dictation, a voice conversation, "Hey Flash".
  const listen = await import("../src/lib/listen.ts");
  let stopped = 0;
  listen.takeMic("dictation", () => stopped++);
  assert.equal(listen.micTakenBy("voice"), true);
  listen.stopMic();
  assert.equal(stopped, 1);
  assert.equal(listen.micTakenBy("voice"), false, "nobody holds it");
  listen.stopMic();
  assert.equal(stopped, 1, "nothing to stop twice");
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  // Every way into add mode goes through openAdding, which ends the voice conversation and stops the
  // mic before the sign-in covers the page (nothing said there, a password read out, is heard or sent).
  assert.match(body(page, "function openAdding("), /\{\n\s+setVoice\(null\);\n\s+stopMic\(\);\n\s+addingRef\.current = \{ \.\.\.next, opened: \+\+addSeq\.current \};\n\s+setAdding\(addingRef\.current\);\n\s+\}$/);
  assert.doesNotMatch(page, /setAdding\(\{/, "add mode opens only through openAdding");
  assert.equal(page.match(/setAdding\(/g)?.length, 3, "openAdding, closeAdding and the account check, which keeps it open");
  assert.equal(page.match(/openAdding\(\{/g)?.length, 5, "the menu, the chooser's two, ?add=1 and a sign-in error");
  assert.match(page, /onAdd=\{\(\) => openAdding\(\{\}\)\}/);
  // "Hey Flash" stays off meanwhile.
  assert.match(page, /useWakeWord\(wakeOn && !voice && !dictating && Boolean\(me\) && !signedOut && !adding,/);
  // The account check never puts the chooser over it: Back leads to the chooser, with who is signed
  // in now; once the tab's account is signed in here again (an emailed link, another tab), the
  // sign-in from the chooser closes and the tab goes on, after a reload too.
  const check = body(page, "async function checkAccounts(");
  assert.match(check, /if \(signingIn\?\.back\) \{\n\s+closeAdding\(\);\n\s+return "back";\n\s+\}\n\s+if \(!chooserRef\.current\) return "here";/);
  assert.match(check, /if \(signingIn\) \{\n\s+const next = \{ \.\.\.signingIn, back: signingIn\.back \? \{ \.\.\.signingIn\.back, accounts: list\.accounts \} : gone \};\n\s+addingRef\.current = next;\n\s+setAdding\(next\);\n\s+return "gone";\n\s+\}\n\s+setChooser\(gone\);/);
  assert.equal(check.match(/setChooser\(\{/g), null, "the chooser shows only when nothing is being signed in to");
  assert.match(page, /if \(!meRef\.current && !chooserRef\.current && !addingRef\.current\?\.back\) return;/);
  // The pages an emailed link and two-step sign-in finish on tell Flash's other tabs at once.
  for (const file of ["SignInLink", "TwoFactorForm"]) {
    const source = await readFile(new URL(`../src/components/${file}.tsx`, import.meta.url), "utf8");
    assert.match(source, /announce\(\{ type: "changed" \}\);\n[^\n]*\n?\s+window\.location\.assign\(/, file);
  }
  // A dialog: it takes the focus, Escape is its Back (and reaches nothing under it, like Ask Flash),
  // and once it closes the focus is back on the profile menu's button.
  const chooser = await readFile(new URL("../src/components/AccountChooser.tsx", import.meta.url), "utf8");
  const over = body(chooser, "export function AddOver(");
  assert.match(over, /el\.focus\(\);/);
  assert.match(over, /if \(e\.key !== "Escape" \|\| e\.isComposing\) return;\n\s+e\.preventDefault\(\);\n\s+e\.stopPropagation\(\);\n\s+back\.current\(\);/);
  // Heard first, on the window as the key goes down, wherever the focus is: on the page itself too,
  // once a button chosen in it ("Email me a sign-in link", "Forgot password?") is gone.
  assert.match(over, /window\.addEventListener\("keydown", key, true\);/);
  assert.match(over, /window\.removeEventListener\("keydown", key, true\);/);
  assert.doesNotMatch(over, /el\.addEventListener/);
  // The focus then moves to the new form's first field, not to the page under it.
  const auth = await readFile(new URL("../src/components/AuthScreen.tsx", import.meta.url), "utf8");
  assert.match(body(auth, "function switchMode("), /switched\.current = true;/);
  assert.match(auth, /useEffect\(\(\) => \{\n\s+if \(!switched\.current\) return;\n\s+switched\.current = false;\n\s+if \(!document\.activeElement \|\| document\.activeElement === document\.body\) form\.current\?\.querySelector<HTMLElement>\("input"\)\?\.focus\(\);\n\s+\}, \[mode\]\);/);
  assert.match(auth, /<form\n\s+ref=\{form\}/);
  // "Switch anyway?" and the account chooser: Escape is theirs (Cancel, when there is one) and goes
  // no further, so Ask Flash under them stays open with its answer, and so does the code not saved.
  const sheet = body(chooser, "function Sheet(");
  assert.match(sheet, /if \(e\.key === "Escape"\) \{\n\s+e\.stopPropagation\(\);\n\s+if \(!onEscape\) return;\n\s+e\.preventDefault\(\);\n\s+onEscape\(\);\n\s+return;\n\s+\}/);
  assert.match(sheet, /window\.addEventListener\("keydown", keep, true\);/);
  assert.match(sheet, /window\.removeEventListener\("keydown", keep, true\);/);
  assert.doesNotMatch(sheet, /document\.addEventListener/);
  assert.match(body(chooser, "export function SwitchAnyway("), /<Sheet label=\{question\} onEscape=\{onCancel\}>/);
  // What they keep Escape from: Ask Flash and the preview listen on the window as the key comes back up, after them.
  const companion = await readFile(new URL("../src/components/Companion.tsx", import.meta.url), "utf8");
  assert.match(companion, /if \(e\.key === "Escape" && open\) onClose\(\);\n\s+\};\n\s+window\.addEventListener\("keydown", onKey\);/);
  const preview = await readFile(new URL("../src/components/AppPreview.tsx", import.meta.url), "utf8");
  assert.match(preview, /if \(e\.key !== "Escape"\) return;\n\s+if \(menu\) setMenu\(false\);\n\s+else if \(picking\) choose\(false\);\n\s+else setFull\(false\);\n\s+\};\n\s+window\.addEventListener\("keydown", onKey\);/);
  assert.match(over, /document\.querySelector<HTMLElement>\("\[data-account-menu\]"\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(over, /role="dialog"\n\s+aria-modal="true"\n\s+aria-label=\{label\}\n\s+tabIndex=\{-1\}/);
  const menu = await readFile(new URL("../src/components/AccountMenu.tsx", import.meta.url), "utf8");
  assert.match(menu, /<button\n\s+data-account-menu\n\s+onClick=\{\(\) => setOpen\(\(o\) => !o\)\}/);
});

test("Add another account saves or asks before the page goes anywhere, and Back while it waits keeps the tab as it was", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  const auth = await readFile(new URL("../src/components/AuthScreen.tsx", import.meta.url), "utf8");
  // Every way out of the sign-in form while adding: a password sign-in ends in addDone; two-step
  // sign-in's code page and a "Continue with …" sign-in leave the page, each through leave, which
  // waits for Flash (addLeave) to save what changed under it, or ask, before going.
  assert.match(page, /leave: \(go\) => addLeave\(adding, go\),\n\s+\}\}\n\s+onDone=\{\(result\) => addDone\(adding, result\)\}/);
  assert.match(body(auth, "async function leave("), /\{\n\s+if \(adding\?\.leave\) await adding\.leave\(go\);\n\s+else go\(\);\n\s+\}$/);
  assert.equal(auth.match(/router\.push\(/g)?.length, 1);
  assert.match(auth, /if \(result\.twoFactor\) \{\n\s+await leave\(\(\) => router\.push\("\/signin\/code"\)\);\n\s+return;\n\s+\}/);
  assert.equal(auth.match(/window\.location/g)?.length, 1, "only leaveBy sends the page elsewhere");
  const by = body(auth, "function leaveBy(");
  assert.match(by, /if \(!adding\?\.leave \|\| e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;\n\s+e\.preventDefault\(\);\n\s+if \(busy\) return;/);
  assert.match(by, /void leave\(\(\) => window\.location\.assign\(href\)\)\.finally\(\(\) => setBusy\(false\)\);/);
  // Each link in the form that opens in this tab goes through leaveBy: the "Continue with …" ones,
  // and demo mode's sign-in link. The Terms and Privacy Policy open in a tab of their own.
  const links = [...auth.matchAll(/<a\s([^>]*)>/g)].map((m) => m[1]);
  assert.equal(links.length, 4);
  for (const link of links) assert.ok(/target="_blank"/.test(link) || /onClick=\{leaveBy\}/.test(link), link);
  assert.equal(auth.match(/onClick=\{leaveBy\}/g)?.length, 2);
  assert.match(auth, /href=\{`\/api\/auth\/oauth\/\$\{id\}.*\n\s+onClick=\{leaveBy\}/);
  // Flash's side: saved, or "Switch anyway?" over the page (Cancel keeps it), as before a switch.
  const leave = body(page, "async function addLeave(");
  assert.match(leave, /const saved = !meRef\.current \|\| Boolean\(from\.back\) \|\| \(await flushSaves\(\)\);\n\s+if \(!stillAdding\(from\)\) return;\n\s+if \(saved\) return go\(\);\n\s+closeAdding\(\);\n\s+setUnsaved\(\{ go \}\);/);
  // Back or Escape while the form says "One moment…" (the sign-in, or the saves before going on, not
  // ended yet): nothing goes on afterwards, no reload as the other account and no question; the
  // menu lists the account signed in to meanwhile.
  assert.match(page, /const stillAdding = \(from: Adding\) => addingRef\.current\?\.opened === from\.opened;/);
  const done = body(page, "async function addDone(");
  assert.match(done, /const stayed = \(\) => \{\n\s+if \(stillAdding\(from\)\) return false;\n\s+window\.dispatchEvent\(new Event\("flash:account-check"\)\);\n\s+return true;\n\s+\};\n\s+if \(stayed\(\)\) return;\n\s+if \(from\.again/);
  assert.match(done, /const saved = !meRef\.current \|\| Boolean\(from\.back\) \|\| \(await flushSaves\(\)\);\n\s+if \(stayed\(\)\) return;\n\s+if \(!saved\) \{/);
  assert.match(done, /setUnsaved\(\{ go: \(\) => goOnAs\(id, from\.next\), added: true \}\);/);
  assert.equal(done.match(/await /g)?.length, 1, "nothing else is waited on before going on");
  // Add mode is numbered each time it opens; the account check keeps that number when it updates Back.
  assert.match(body(page, "async function checkAccounts("), /const next = \{ \.\.\.signingIn, back:/);
});

test("a log out says it's under way while it saves what it can, and runs once", async () => {
  const { readFile } = await import("node:fs/promises");
  const menu = await readFile(new URL("../src/components/AccountMenu.tsx", import.meta.url), "utf8");
  // The menu stays open with "Logging out…" on the item, the other account items wait, and a
  // second log out is ignored; when the tab stays on its account, the menu closes so the reason shows.
  const logOut = menu.slice(menu.indexOf("const logOut = "), menu.indexOf("const outItem = "));
  assert.match(logOut, /if \(out\) return;\n\s+setOut\(which\);/);
  assert.match(logOut, /void fn\(\)\.then\(\(left\) => \(left \? window\.setTimeout\(\(\) => setOut\(null\), 3000\) : stay\(\)\), stay\);/);
  assert.equal(menu.match(/\{\.\.\.outItem\("one"\)\}/g)?.length, 2, "with one account and with several");
  assert.equal(menu.match(/\{\.\.\.outItem\("all"\)\}/g)?.length, 1);
  assert.equal(menu.match(/t\("Logging out…"\)/g)?.length, 3);
  assert.doesNotMatch(menu, /pick\(onSignOut/);
  assert.equal(menu.match(/disabled=\{Boolean\(switching \|\| out\)\}/g)?.length, 2, "switching to another account, and adding one");
  const page = await readFile(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  for (const start of ["async function signOut(", "async function signOutAll("]) {
    assert.match(body(page, start), /\{\n(\s*\/\/.*\n)*\s+if \(leavingRef\.current\) return false;\n\s+leavingRef\.current = true;/, start);
  }
  assert.match(body(page, "function signedOutHere("), /leavingRef\.current = false;/);
});
