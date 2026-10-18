import { test } from "node:test";
import assert from "node:assert/strict";

// Its own process (node --test runs each file in one), so the once-per-process warnings start unsaid.
process.env.DATABASE_URL = ":memory:";
// A key whose name Flash doesn't read as live (it knows sk_live_ and rk_live_), so it is taken for a test key.
process.env.STRIPE_SECRET_KEY = "sk_prod_Q7mZ2";
console.error = () => {};
/** What the server log was told (see inKeyMode in shop.ts). */
const warnings: string[] = [];
console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
const { run, one } = await import("../src/lib/server/db.ts");
const shop = await import("../src/lib/server/shop.ts");

const ORIGIN = "https://www.flash-app.dev";
// A mock Stripe that leaves livemode out of what it sends.
const session: Record<string, unknown> = {
  id: "cs_mock",
  object: "checkout.session",
  payment_status: "paid",
  amount_total: 2500,
  currency: "cad",
  created: Math.floor(Date.now() / 1000),
  metadata: { flash_site: "cake-1", flash_item: "Cake" },
  customer_details: { email: "ana@example.com", name: "Ana" },
  line_items: { data: [{ quantity: 1 }] },
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace("/v1", "");
  if (path === "/checkout/sessions/cs_mock") return Response.json(session);
  if (path === "/checkout/sessions") return Response.json({ data: [session] });
  return Response.json({ error: { message: `unexpected ${path}` } }, { status: 400 });
}) as typeof fetch;

await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'owner@x.co', 'h', 0, 1)");
await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('cake-1', 'u1', 'Crumb', '<p>', 0, 0)");
await run("INSERT INTO seller_accounts (user_id, stripe_account, country, currency, ready, created_at) VALUES ('u1', 'acct_A', 'CA', 'cad', 1, 0)");
const saved = async () => Boolean(await one("SELECT 1 FROM site_orders WHERE session_id = 'cs_mock'"));
const checkoutEvent = (id: string, livemode: unknown) => ({ id, type: "checkout.session.completed", account: "acct_A", livemode, data: { object: session } });

test("a checkout with no mode is refused as one in the other mode is, and the server log says so once, with both modes and nothing of the key", async () => {
  // The return page and the owner's sync both refuse it, and the log says it once.
  assert.deepEqual(await shop.finishCheckout("cake-1", "cs_mock", null, ORIGIN), { page: `${ORIGIN}/p/cake-1`, paid: false });
  await shop.syncOrders("u1", "cake-1");
  assert.equal(await saved(), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[flash\] Didn't save a paid Stripe checkout as an order: it came without a mode, and STRIPE_SECRET_KEY reads as a test key\. /);
  assert.match(warnings[0], /check STRIPE_SECRET_KEY and STRIPE_API_BASE/);
  // A live event under a key read as a test one is ignored, and said once too, apart from orders.
  assert.equal(await shop.connectEvent(checkoutEvent("evt_live", true), ORIGIN), "ignored");
  assert.equal(await shop.connectEvent(checkoutEvent("evt_none", undefined), ORIGIN), "ignored");
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /^\[flash\] Ignored a Stripe event: it came in live mode, and STRIPE_SECRET_KEY reads as a test key\. /);
  assert.doesNotMatch(warnings[1], /sellers' test-mode events/, "that is only said of a test-mode event under a live key");
  // An event in the key's mode whose checkout has none: refused at the order, and nothing more said.
  assert.equal(await shop.connectEvent(checkoutEvent("evt_test", false), ORIGIN), "unchanged");
  assert.equal(await saved(), false);
  assert.equal(warnings.length, 2, "once per server process for each");
  for (const said of warnings) assert.doesNotMatch(said, /sk_|prod|Q7mZ2/, "nothing of the key");
  // The key's own mode is saved, and says nothing.
  session.livemode = false;
  assert.deepEqual(await shop.finishCheckout("cake-1", "cs_mock", null, ORIGIN), { page: `${ORIGIN}/p/cake-1`, paid: true });
  assert.equal(await saved(), true);
  assert.equal(warnings.length, 2);
});
