import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

process.env.DATABASE_URL = ":memory:";
const { run, one } = await import("../src/lib/server/db.ts");
const { receiveMessage, readMessages, ownsSite, sitesWithMessages, deleteMessage } = await import("../src/lib/server/inbox.ts");
const { buildSystem } = await import("../src/lib/engines/builder.ts");
const { flashDbShim } = await import("../src/lib/flashdb-shim.ts");

const status = (r: { ok: true } | { status: number }) => ("status" in r ? r.status : 200);

test("site forms reach only the owner, marked read once seen", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'owner@x.co', 'h', 0), ('u2', 'other@x.co', 'h', 0)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('bakery-1', 'u1', 'Crumb Bakery', '<p>', 0, 0)");
  const sent = await receiveMessage("bakery-1", { form: "contact", data: { name: "Ana", email: "ana@example.com", message: "Do you bake gluten-free?" } }, "1.1.1.1", "https://www.flash-app.dev");
  assert.deepEqual(sent, { ok: true });

  assert.equal(status(await receiveMessage("bakery-1", { form: "bad name!", data: {} }, "1.1.1.1", "")), 400);
  assert.equal(status(await receiveMessage("bakery-1", { form: "contact", data: ["x"] }, "1.1.1.1", "")), 400);
  assert.equal(status(await receiveMessage("bakery-1", { form: "contact", data: { m: "x".repeat(20_000) } }, "1.1.1.1", "")), 413);
  assert.equal(status(await receiveMessage("nope", { form: "contact", data: { a: 1 } }, "2.2.2.2", "")), 404);

  assert.equal(await ownsSite("u1", "bakery-1"), true);
  assert.equal(await ownsSite("u2", "bakery-1"), false);
  assert.deepEqual(
    (await sitesWithMessages("u1")).map((s) => [s.slug, s.messages, s.unread]),
    [["bakery-1", 1, 1]],
  );
  const [first] = await readMessages("bakery-1");
  assert.equal(first.form, "contact");
  assert.equal(first.data.email, "ana@example.com");
  assert.equal(first.read, false, "shows as new the first time");
  assert.equal((await readMessages("bakery-1"))[0].read, true);
  assert.equal((await sitesWithMessages("u1"))[0].unread, 0);
  // The public flashDB data API never sees form messages.
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_records"))?.n, 0);

  await deleteMessage("bakery-1", first.id);
  assert.deepEqual(await readMessages("bakery-1"), []);
});

test("one visitor can send at most 10 forms an hour", async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await receiveMessage("bakery-1", { form: "contact", data: { i } }, "9.9.9.9", "");
  assert.equal(status(last!), 429);
  assert.equal((await readMessages("bakery-1")).length, 10);
});

test("unpublishing a site removes its messages", async () => {
  await run("DELETE FROM sites WHERE slug = 'bakery-1'");
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_messages"))?.n, 0);
});

test("the app builder makes multi-page sites and sends forms privately", () => {
  const system = buildSystem("app", "");
  assert.match(system, /<section data-page="name">/);
  assert.match(system, /href="#\/name"/);
  assert.match(system, /flashDB\.send\("contact"/);
  assert.doesNotMatch(buildSystem("slides", ""), /data-page/);
  assert.match(flashDbShim("/api/sites/x/data", "/api/sites/x/inbox"), /"\/api\/sites\/x\/inbox"/);
  assert.match(flashDbShim(null), /async send\(form, data, options\)/, "the preview has send too, without sending");
});

/** What the shim puts on window, as a test reads it. */
type ShimWindow = {
  flashDB: { track(step: unknown): Promise<boolean>; buy(item: string): Promise<void> };
  flashAuth: { signUp(email: string, password: string, name: string): Promise<void> };
};

/**
 * Runs the published shim in a page with timers this test moves by hand, and records what it sends.
 * Pages in other tests have no timers or listeners at all, and nothing may need them while loading.
 */
function trackingPage() {
  const sent: { url: string; method: string; body: unknown; type?: string; keepalive?: boolean }[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let clock = 0;
  let next = 1;
  const listeners: Record<string, (() => void)[]> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    addEventListener: (type: string, fn: () => void) => (docListeners[type] ??= []).push(fn),
    createElement: () => ({ style: {}, appendChild() {}, submit() { sent.push({ url: "form", method: "POST", body: "submit" }); } }),
    body: { appendChild() {} },
  };
  const fetch = (url: string, init: { method: string; body: unknown; headers: Record<string, string>; keepalive?: boolean }) => {
    sent.push({ url, method: init.method, body: init.body, type: init.headers["Content-Type"], keepalive: init.keepalive });
    return Promise.resolve(new Response(JSON.stringify({ url: "https://checkout.stripe.com/x" }), { status: 200 }));
  };
  const window = {} as ShimWindow;
  const location = { href: "https://www.flash-app.dev/p/x" };
  const code = flashDbShim("/api/sites/x/data", "/i", "/api/sites/x/shop", false, "/api/sites/x/auth", null, null, null, null, null, "k".repeat(16), "/api/sites/x/track").replace(
    /^<script>|<\/script>$/g,
    "",
  );
  vm.runInNewContext(code, {
    window,
    document,
    fetch,
    location,
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    console: { warn() {}, info() {} },
    setTimeout: (fn: () => void, ms: number) => (timers.set(next, { at: clock + ms, fn }), next++),
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn),
    Promise,
    JSON,
  });
  const wait = (ms: number) => {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at > clock) continue;
      timers.delete(id);
      t.fn();
    }
  };
  const fire = (type: string) => (listeners[type] ?? []).forEach((fn) => fn());
  const hide = () => {
    document.visibilityState = "hidden";
    (docListeners.visibilitychange ?? []).forEach((fn) => fn());
  };
  const steps = () => sent.filter((r) => r.url.endsWith("/track"));
  return { window, sent, steps, wait, fire, hide, document };
}

test("flashDB.track sends a page's steps in one plain-text request, 5 seconds after the last, or at once when the page is hidden or left", async () => {
  const page = trackingPage();
  assert.equal(await page.window.flashDB.track("Booking-Started"), true);
  assert.equal(await page.window.flashDB.track("plan-chosen"), true);
  assert.equal(await page.window.flashDB.track("booking-started"), true, "the same step again is fine");
  assert.equal(await page.window.flashDB.track("order-1234567"), false, "a name that carries an ID isn't counted");
  assert.equal(await page.window.flashDB.track("checkout"), false, "Flash counts checkouts itself");
  assert.equal(await page.window.flashDB.track(""), false);
  page.wait(4_900);
  assert.equal(page.steps().length, 0, "nothing within 5 s of the last call");
  page.wait(200);
  assert.deepEqual(page.steps(), [{ url: "https://www.flash-app.dev/api/sites/x/track", method: "POST", body: "booking-started\nplan-chosen", type: undefined, keepalive: true }]);
  // A step already sent from this page isn't sent again; a new one goes when the page is hidden.
  await page.window.flashDB.track("booking-started");
  await page.window.flashDB.track("menu-opened");
  page.hide();
  assert.deepEqual(page.steps().map((r) => r.body), ["booking-started\nplan-chosen", "menu-opened"]);
  page.wait(10_000);
  assert.equal(page.steps().length, 2, "the timer was stopped");
  await page.window.flashDB.track("gallery");
  page.fire("pagehide");
  assert.deepEqual(page.steps().map((r) => r.body), ["booking-started\nplan-chosen", "menu-opened", "gallery"]);
  page.fire("pagehide");
  assert.equal(page.steps().length, 3, "nothing waiting, nothing sent");
});

test("buying and signing in send the steps waiting first, as the page leaves right after", async () => {
  const page = trackingPage();
  await page.window.flashDB.track("cart-opened");
  void page.window.flashDB.buy("Cake");
  await new Promise((r) => setTimeout(r, 10));
  const buyAt = page.sent.findIndex((r) => r.url.endsWith("/shop"));
  const trackAt = page.sent.findIndex((r) => r.url.endsWith("/track"));
  assert.ok(buyAt >= 0 && trackAt > buyAt, "sent once the checkout link came back, before going to it");
  const signing = trackingPage();
  await signing.window.flashDB.track("signup-opened");
  void signing.window.flashAuth.signUp("a@b.co", "longenough1", "A");
  assert.deepEqual(
    signing.sent.map((r) => r.url),
    ["https://www.flash-app.dev/api/sites/x/track", "form"],
    "before the sign-up form leaves",
  );
  // Up to 15 different steps a page.
  const many = trackingPage();
  for (let i = 0; i < 16; i++) await many.window.flashDB.track(`step-${i}`);
  many.wait(5_000);
  assert.equal(String(many.steps()[0].body).split("\n").length, 15);
});

test("the preview and downloaded apps have flashDB.track too, sending nothing", async () => {
  const memory = flashDbShim(null);
  assert.match(memory, /async track\(step\)/);
  assert.doesNotMatch(memory, /\/track/);
  const window = {} as ShimWindow;
  vm.runInNewContext(memory.replace(/^<script>|<\/script>$/g, ""), { window, console: { info() {}, warn() {} }, JSON });
  assert.equal(await window.flashDB.track("booking"), true);
  assert.equal(await window.flashDB.track("Not a name!"), false);
  assert.match(buildSystem("app", ""), /flashDB\.track\("step-name"\)/, "the builder knows to use it");
});

