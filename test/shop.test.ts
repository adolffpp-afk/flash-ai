import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.STRIPE_SECRET_KEY = "rk_test";
process.env.FLASH_ADMIN_EMAILS = "owner@x.co";
const { run, one } = await import("../src/lib/server/db.ts");
const shop = await import("../src/lib/server/shop.ts");
const { toMinor, formatMoney, saleFee, itemsInHtml, safeReturn, withPaidNote, cleanItemName } = await import("../src/lib/shop.ts");
const { routeHost } = await import("../src/lib/site-host.ts");
const { flashDbShim } = await import("../src/lib/flashdb-shim.ts");

test("prices people type become Stripe amounts", () => {
  assert.equal(toMinor("12.50", "cad"), 1250);
  assert.equal(toMinor("12,5", "eur"), 1250);
  assert.equal(toMinor("$8", "usd"), 800);
  assert.equal(toMinor("1500", "jpy"), 1500);
  assert.equal(toMinor("15.50", "jpy"), null, "yen has no cents");
  assert.equal(toMinor("abc", "usd"), null);
  assert.equal(toMinor("1.234", "usd"), null);
  assert.equal(formatMoney(1250, "cad"), "CA$12.50");
  assert.equal(formatMoney(1500, "jpy"), "¥1,500");
  assert.equal(saleFee(1250, 200), 25);
  assert.equal(saleFee(50, 200), 1);
  assert.equal(cleanItemName("  Chocolate   cake "), "Chocolate cake");
  assert.equal(cleanItemName(""), null);
});

test("the item names a site sells are found in its code", () => {
  const html = `<button onclick="flashDB.buy('Chocolate cake')">Buy</button>
    <span data-flash-price="Chocolate cake">$12</span><span data-flash-price="Croissant &amp; jam">$4</span>
    <script>flashDB.buy("Gift card", { quantity: 2 }); flashDB.buy(\`\${item.name}\`)</script>`;
  assert.deepEqual(itemsInHtml(html), ["Chocolate cake", "Gift card", "Croissant & jam"]);
});

test("buyers only go back to the site's own addresses", () => {
  const sites = ["https://www.flash-app.dev/p/crumb-1", "https://crumbbakery.com"];
  assert.equal(safeReturn("https://crumbbakery.com/?flash_paid=1#/menu", sites), "https://crumbbakery.com/#/menu");
  assert.equal(safeReturn("https://www.flash-app.dev/p/crumb-1#/shop", sites), "https://www.flash-app.dev/p/crumb-1#/shop");
  assert.equal(safeReturn("https://evil.example/p/crumb-1", sites), sites[0]);
  assert.equal(safeReturn("javascript:alert(1)", sites), sites[0]);
  assert.equal(withPaidNote("https://crumbbakery.com/#/menu"), "https://crumbbakery.com/?flash_paid=1#/menu");
  assert.deepEqual(routeHost("crumbbakery.com", "/api/sites/crumb-1/shop", "POST"), { pass: true });
  assert.deepEqual(routeHost("crumbbakery.com", "/api/sites/crumb-1/shop/done", "GET"), { redirect: "/" });
});

test("the published shim can buy, and the preview explains payments wait for publishing", () => {
  const live = flashDbShim("/d", "/i", "/api/sites/x/shop", true);
  assert.match(live, /async buy\(item, options\)/);
  assert.match(live, /if \(paid \|\| true\) ready/);
  assert.match(flashDbShim("/d", "/i", "/s", false), /if \(paid \|\| false\) ready/);
  assert.match(flashDbShim(null), /Payments work once the site is published/);
});

test("a seller connects Stripe, prices items, and buyers pay through Checkout", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'owner@x.co', 'h', 0, 1), ('u2', 'free@x.co', 'h', 0, 1)");
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-1', 'u1', 'Crumb', '<p>', 0, 0)");
  const calls: { method: string; path: string; body: URLSearchParams; account?: string }[] = [];
  let chargesEnabled = false;
  const paidSession = {
    id: "cs_test_1",
    payment_status: "paid",
    amount_total: 2500,
    currency: "cad",
    created: 1_700_000_000,
    metadata: { flash_site: "crumb-1", flash_item: "Chocolate cake" },
    customer_details: { email: "buyer@x.co", name: "Ana" },
    line_items: { data: [{ quantity: 2 }] },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/v1", "") + url.search;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path, body: new URLSearchParams(String(init?.body ?? "")), account: headers["Stripe-Account"] });
    if (url.hostname === "api.resend.com") return Response.json({ id: "e" });
    if (path === "/accounts" && init?.method === "POST") return Response.json({ id: "acct_seller", default_currency: "cad" });
    if (path.startsWith("/accounts/")) return Response.json({ charges_enabled: chargesEnabled, default_currency: "cad", country: "CA" });
    if (path === "/account_links") return Response.json({ url: "https://connect.stripe.com/setup/x" });
    if (path === "/checkout/sessions" && init?.method === "POST") return Response.json({ url: "https://checkout.stripe.com/c/pay/x" });
    if (path.startsWith("/checkout/sessions/cs_test_1")) return Response.json(paidSession);
    if (path.startsWith("/checkout/sessions?")) return Response.json({ data: [paidSession, { ...paidSession, id: "cs_other", metadata: { flash_site: "other" } }] });
    return Response.json({ error: { message: "unexpected " + path } }, { status: 400 });
  }) as typeof fetch;
  const owner = { id: "u1", email: "owner@x.co", name: "", verified_at: 1 } as never;
  const free = { id: "u2", email: "free@x.co", name: "", verified_at: 1 } as never;
  const origin = "https://www.flash-app.dev";

  const denied = await shop.sellerOnboardingLink(free, "CA", origin);
  assert.equal("status" in denied && denied.status, 402, "selling needs a paid plan");
  const noCountry = await shop.sellerOnboardingLink(owner, "XX", origin);
  assert.equal("status" in noCountry && noCountry.status, 400);

  const working = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: { message: "Please review the responsibilities of managing losses." } }, { status: 400 })) as typeof fetch;
  const refused = await shop.sellerOnboardingLink(owner, "CA", origin);
  assert.match("error" in refused ? refused.error : "", /Stripe says: Please review the responsibilities/, "admins see Stripe's reason");
  globalThis.fetch = working;

  const link = await shop.sellerOnboardingLink(owner, "CA", origin);
  assert.deepEqual(link, { url: "https://connect.stripe.com/setup/x" });
  const created = calls.find((c) => c.path === "/accounts")!;
  assert.equal(created.body.get("controller[fees][payer]"), "account", "the seller pays Stripe's fees, not Flash");
  assert.equal(created.body.get("controller[losses][payments]"), "stripe");
  assert.equal(calls.find((c) => c.path === "/account_links")!.body.get("return_url"), `${origin}/?apps=1`);

  // Not ready until Stripe says the account can take charges.
  assert.equal((await shop.sellerStatus("u1")).ready, false);
  const early = await shop.saveProduct(owner, "crumb-1", { name: "Chocolate cake", price: "12.50" });
  assert.equal("status" in early && early.status, 409);
  chargesEnabled = true;
  assert.deepEqual(await shop.sellerStatus("u1"), { connected: true, ready: true, currency: "cad", country: "CA" });

  const tooCheap = await shop.saveProduct(owner, "crumb-1", { name: "Mint", price: "0.20" });
  assert.equal("status" in tooCheap && tooCheap.status, 400);
  const cake = await shop.saveProduct(owner, "crumb-1", { name: "Chocolate cake", price: "12.50", delivery: true });
  assert.ok(!("error" in cake) && cake.label === "CA$12.50");
  const repriced = await shop.saveProduct(owner, "crumb-1", { name: "chocolate CAKE", price: "12.50" });
  assert.ok(!("error" in repriced) && "id" in cake && repriced.id === cake.id, "same name, any case, changes the same item");
  assert.deepEqual(await shop.publicItems("crumb-1"), [{ name: "chocolate CAKE", price: "CA$12.50" }]);

  const missing = await shop.startCheckout("crumb-1", { item: "Croissant" }, "1.1.1.1", origin);
  assert.equal("status" in missing && missing.status, 404);
  const tooMany = await shop.startCheckout("crumb-1", { item: "Chocolate cake", quantity: 99 }, "1.1.1.1", origin);
  assert.equal("status" in tooMany && tooMany.status, 400);
  const checkout = await shop.startCheckout(
    "crumb-1",
    { item: "Chocolate Cake", quantity: 2, page: "https://evil.example/" },
    "1.1.1.1",
    origin,
  );
  assert.deepEqual(checkout, { url: "https://checkout.stripe.com/c/pay/x" });
  const session = calls.findLast((c) => c.path === "/checkout/sessions")!;
  assert.equal(session.account, "acct_seller", "the charge is made on the seller's own account");
  assert.equal(session.body.get("line_items[0][price_data][unit_amount]"), "1250", "the price comes from Flash, not the page");
  assert.equal(session.body.get("payment_intent_data[application_fee_amount]"), "50", "Flash keeps 2%");
  assert.equal(session.body.get("cancel_url"), `${origin}/p/crumb-1`, "an unknown page sends buyers to the site");
  assert.equal(session.body.get("shipping_address_collection[allowed_countries][0]"), null, "delivery was switched off");

  const fake = await shop.finishCheckout("crumb-1", "not-a-session", null, origin);
  assert.deepEqual(fake, { page: `${origin}/p/crumb-1`, paid: false });
  const done = await shop.finishCheckout("crumb-1", "cs_test_1", `${origin}/p/crumb-1#/shop`, origin);
  assert.deepEqual(done, { page: `${origin}/p/crumb-1#/shop`, paid: true });
  await shop.finishCheckout("crumb-1", "cs_test_1", null, origin);
  assert.equal(calls.filter((c) => c.path === "/emails").length, 0, "no email service in tests");
  const orders = await shop.listOrders("u1", "crumb-1");
  assert.equal(orders.length, 1, "a session is saved once, and other sites' sales are left out");
  assert.deepEqual({ ...orders[0], createdAt: 0 }, {
    id: "cs_test_1",
    item: "Chocolate cake",
    quantity: 2,
    total: "CA$25.00",
    email: "buyer@x.co",
    name: "Ana",
    address: "",
    createdAt: 0,
  });

  // Unpublishing a site takes its items and orders with it.
  await run("DELETE FROM sites WHERE slug = 'crumb-1'");
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_products"))?.n, 0);
});
