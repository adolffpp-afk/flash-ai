import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.VERCEL_API_TOKEN = "t";
process.env.VERCEL_PROJECT_ID = "flash-ai";
process.env.FLASH_ADMIN_EMAILS = "owner@x.co";
process.env.NAMECOM_USERNAME = "AI-Flash-Inc";
process.env.NAMECOM_TOKEN = "live-token";
process.env.NAMECOM_TEST_TOKEN = "test-token";
process.env.NAMECOM_MODE = "live";
process.env.FLASH_DOMAIN_SALES = "admins";
process.env.STRIPE_SECRET_KEY = "sk_test_x";

const { run, one } = await import("../src/lib/server/db.ts");
const orders = await import("../src/lib/server/domain-orders.ts");
const { ownershipValue } = await import("../src/lib/server/domains.ts");

const admin = { id: "u1", email: "owner@x.co", name: "", preferences: "", created_at: 0, last_free_grant: 0, verified_at: 1 };
const other = { ...admin, id: "u2", email: "someone@x.co" };
const contact = {
  firstName: "Ana",
  lastName: "Lopez",
  address1: "1 Rue Main",
  city: "Montréal",
  state: "QC",
  zip: "H2X 1Y4",
  country: "ca",
  email: "ana@x.co",
  phone: "+1 (514) 555-0100",
};
await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'owner@x.co', 'h', 0, 1), ('u2', 'someone@x.co', 'h', 0, 1)");
await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-1', 'u1', 'Golden Crumb', '<p>', 0, 0)");

/*
 * Name.com, Stripe and Vercel, as fakes. Each test sets what Name.com's purchase answers and its
 * live price; every call is kept so a test can count them.
 */
type Fake = {
  price: number;
  buy: () => Response | Promise<Response>;
  owned: boolean;
  risk: string;
  paymentStatus: string;
  calls: { method: string; url: string; body: string; headers: Headers }[];
};
let fake: Fake;
beforeEach(async () => {
  await run("DELETE FROM domain_orders");
  await run("DELETE FROM owned_domains");
  await run("DELETE FROM site_domains");
  await run("DELETE FROM rate_limits");
  fake = { price: 10.99, buy: () => bought(), owned: false, risk: "normal", paymentStatus: "requires_capture", calls: [] };
});

const bought = () => {
  fake.owned = true;
  return Response.json({
    domain: { domainName: "goldencrumb.com", createDate: "2026-10-21T00:00:00Z", expireDate: "2027-10-21T00:00:00Z", autorenewEnabled: false, locked: true, privacyEnabled: true, nameservers: [], renewalPrice: 10.99 },
    order: 77,
    totalPaid: fake.price,
  });
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
  fake.calls.push({ method, url, body, headers: new Headers(init?.headers) });
  if (url.startsWith("https://api.name.com") || url.startsWith("https://api.dev.name.com")) {
    const path = new URL(url).pathname;
    if (path.endsWith("domains:checkAvailability") || path.endsWith("domains:search")) {
      return Response.json({
        results: [
          { domainName: "goldencrumb.com", sld: "goldencrumb", tld: "com", purchasable: true, premium: false, purchasePrice: fake.price, purchaseType: "registration", renewalPrice: 10.99 },
          { domainName: "goldencrumb.net", sld: "goldencrumb", tld: "net", purchasable: true, premium: true, purchasePrice: 500, purchaseType: "registration", renewalPrice: 15 },
          { domainName: "goldencrumb.org", sld: "goldencrumb", tld: "org", purchasable: false },
        ],
      });
    }
    if (method === "POST" && path === "/core/v1/domains") return fake.buy();
    if (method === "GET" && path === "/core/v1/domains/goldencrumb.com") {
      return fake.owned ? bought() && Response.json({ domainName: "goldencrumb.com", expireDate: "2027-10-21T00:00:00Z" }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (path.endsWith("/records") && method === "GET") return Response.json({ records: [{ id: 9, host: null, type: "A", answer: "1.2.3.4", ttl: 300 }] });
    if (path.endsWith("/records/9") && method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/records") && method === "POST") return Response.json({ id: 10, ...JSON.parse(body) });
    return Response.json({ message: "unexpected" }, { status: 500 });
  }
  if (url.startsWith("https://api.stripe.com")) {
    const path = new URL(url).pathname;
    if (path === "/v1/checkout/sessions" && method === "POST") return Response.json({ id: "cs_1", url: "https://checkout.stripe.com/cs_1" });
    if (path.startsWith("/v1/checkout/sessions/")) return Response.json({ status: "complete", payment_intent: "pi_1" });
    if (path.endsWith("/capture")) {
      fake.paymentStatus = "succeeded";
      return Response.json({ id: "pi_1", status: "succeeded" });
    }
    if (path.endsWith("/cancel")) {
      fake.paymentStatus = "canceled";
      return Response.json({ id: "pi_1", status: "canceled" });
    }
    if (path === "/v1/payment_intents/pi_1") {
      return Response.json({ id: "pi_1", status: fake.paymentStatus, amount: 99999, amount_capturable: 99999, currency: "usd", latest_charge: { outcome: { risk_level: fake.risk } } });
    }
  }
  if (url.startsWith("https://api.vercel.com")) {
    if (url.includes("/config")) return Response.json({ misconfigured: true, recommendedIPv4: [{ rank: 1, value: ["216.198.79.1"] }], recommendedCNAME: [{ rank: 1, value: "abc.vercel-dns-017.com." }] });
    return Response.json({ name: "x", verified: true });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const count = (pred: (c: Fake["calls"][number]) => boolean) => fake.calls.filter(pred).length;
const buys = () => count((c) => c.method === "POST" && c.url === "https://api.name.com/core/v1/domains");
const captures = () => count((c) => c.url.endsWith("/capture"));
const cancels = () => count((c) => c.url.endsWith("/cancel"));
const status = async (id: string) => (await one<{ status: string; error: string }>("SELECT status, error FROM domain_orders WHERE id = ?", [id]))!;

async function startAndHold(): Promise<string> {
  const started = await orders.startDomainOrder(admin as never, "live", { domain: "goldencrumb.com", siteSlug: "crumb-1", contact, accepted: true }, "https://flash.test");
  assert.ok("url" in started, JSON.stringify(started));
  await orders.domainCheckoutCompleted("cs_1", started.order, "pi_1");
  return started.order;
}

test("only admins can buy for now, and only with sales switched on", () => {
  assert.equal(orders.domainSalesFor(admin), "live");
  assert.equal(orders.domainSalesFor(other), null);
  process.env.FLASH_DOMAIN_SALES = "off";
  assert.equal(orders.domainSalesFor(admin), null);
  process.env.NAMECOM_MODE = "";
  assert.equal(orders.domainSalesFor(admin), "sandbox", "Name.com's sandbox needs no sales switch, as nothing is paid");
  process.env.NAMECOM_MODE = "live";
  process.env.FLASH_DOMAIN_SALES = "admins";
});

test("search offers only names Flash sells, at Flash's price", async () => {
  const found = await orders.searchDomains("live", "Golden Crumb");
  assert.ok(found);
  assert.deepEqual(found.offers.map((o) => o.domain), ["goldencrumb.com"], "the premium and the taken names are left out");
  assert.ok(found.offers[0].priceCents > 1099);
});

test("the registrant's details are checked and cleaned for Name.com", () => {
  const ok = orders.cleanContact(contact);
  assert.ok("contact" in ok);
  assert.equal(ok.contact.phone, "+15145550100");
  assert.equal(ok.contact.country, "CA");
  assert.ok("error" in orders.cleanContact({ ...contact, phone: "514 555 0100" }));
  assert.ok("error" in orders.cleanContact({ ...contact, country: "IR" }));
  assert.ok("error" in orders.cleanContact({ ...contact, city: "" }));
});

test("held, bought, then charged: the domain is the customer's and points at their site", async () => {
  const id = await startAndHold();
  assert.equal((await status(id)).status, "done");
  assert.equal(buys(), 1);
  assert.equal(captures(), 1);
  assert.equal(cancels(), 0);
  const buy = fake.calls.find((c) => c.method === "POST" && c.url === "https://api.name.com/core/v1/domains")!;
  assert.equal(buy.headers.get("x-idempotency-key"), id, "the order's id makes a retry safe");
  const sent = JSON.parse(buy.body);
  assert.equal(sent.purchasePrice, 10.99, "Name.com refuses rather than charge more than quoted");
  assert.equal(sent.years, 1);
  assert.equal(sent.domain.autorenewEnabled, false);
  assert.equal(sent.domain.contacts.registrant.email, "ana@x.co", "the customer is the registrant");
  assert.equal(buy.headers.get("authorization"), `Basic ${Buffer.from("AI-Flash-Inc:live-token").toString("base64")}`);
  const owned = await one<{ user_id: string; registrant_email: string }>("SELECT * FROM owned_domains WHERE domain = 'goldencrumb.com'");
  assert.equal(owned?.user_id, "u1");
  assert.equal(owned?.registrant_email, "ana@x.co");
  // The parking record goes, and Vercel's records and the _flash proof are written.
  assert.equal(count((c) => c.method === "DELETE" && c.url.endsWith("/records/9")), 1);
  const records = fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/records")).map((c) => JSON.parse(c.body));
  assert.deepEqual(records.map((r) => [r.host, r.type, r.answer]), [["", "A", "216.198.79.1"], ["www", "CNAME", "abc.vercel-dns-017.com"], ["_flash", "TXT", ownershipValue("u1")]]);
  assert.equal(await one<{ site_slug: string }>("SELECT site_slug FROM site_domains WHERE domain = 'goldencrumb.com'").then((r) => r?.site_slug), "crumb-1");
  const view = await orders.orderFor("u1", id);
  assert.equal(view?.status, "live");
  assert.equal(await orders.orderFor("u2", id), null, "nobody else sees the order");
  const kept = await one<{ contact: string }>("SELECT contact FROM domain_orders WHERE id = ?", [id]);
  assert.ok(!kept!.contact.includes("Rue Main"), "the address isn't kept once the order ends");
});

test("a webhook sent twice, or the finisher at the same time, buys once", async () => {
  const id = await startAndHold();
  await orders.domainCheckoutCompleted("cs_1", id, "pi_1");
  await orders.finishOrder(id);
  await orders.finishOpenOrders();
  assert.equal(buys(), 1);
  assert.equal(captures(), 1);
});

test("no answer from Name.com keeps the hold, and the retry uses the same key", async () => {
  let first = true;
  fake.buy = () => {
    if (first) {
      first = false;
      throw new Error("timed out");
    }
    return bought();
  };
  const id = await startAndHold();
  assert.equal((await status(id)).status, "unknown");
  assert.equal(cancels(), 0, "a purchase that may have gone through never lets the hold go");
  assert.equal(captures(), 0);
  await orders.finishOrder(id);
  assert.equal((await status(id)).status, "done");
  const keys = fake.calls.filter((c) => c.method === "POST" && c.url === "https://api.name.com/core/v1/domains").map((c) => c.headers.get("x-idempotency-key"));
  assert.deepEqual(keys, [id, id]);
  assert.equal(captures(), 1);
});

test("a clear refusal lets the hold go, and nothing is charged", async () => {
  fake.buy = () => Response.json({ message: "Purchase price does not match" }, { status: 400 });
  const id = await startAndHold();
  assert.equal((await status(id)).status, "failed");
  assert.equal(cancels(), 1);
  assert.equal(captures(), 0);
  assert.equal(await one("SELECT 1 FROM owned_domains"), null);
});

test("a price that went up since the quote is never bought", async () => {
  const started = await orders.startDomainOrder(admin as never, "live", { domain: "goldencrumb.com", siteSlug: "crumb-1", contact, accepted: true }, "https://flash.test");
  assert.ok("order" in started);
  fake.price = 12.5;
  await orders.domainCheckoutCompleted("cs_1", started.order, "pi_1");
  assert.equal((await status(started.order)).status, "failed");
  assert.equal(buys(), 0);
  assert.equal(cancels(), 1);
});

test("a card Stripe's fraud check doesn't pass is let go before anything is bought", async () => {
  fake.risk = "elevated";
  const id = await startAndHold();
  assert.equal((await status(id)).status, "cancelled");
  assert.equal(buys(), 0);
  assert.equal(cancels(), 1);
});

test("past Name.com's replay window, the account says whether an unknown purchase went through", async () => {
  fake.buy = () => {
    throw new Error("timed out");
  };
  const id = await startAndHold();
  await run("UPDATE domain_orders SET buy_started_at = ? WHERE id = ?", [Date.now() - 2 * 60 * 60_000, id]);
  fake.owned = true;
  await orders.finishOrder(id);
  assert.equal((await status(id)).status, "done");
  assert.equal(captures(), 1);
  assert.equal(buys(), 1, "never bought again after the window");

  const second = await (async () => {
    await run("DELETE FROM domain_orders");
    await run("DELETE FROM owned_domains");
    fake.owned = false;
    fake.paymentStatus = "requires_capture";
    return startAndHold();
  })();
  await run("UPDATE domain_orders SET buy_started_at = ? WHERE id = ?", [Date.now() - 2 * 60 * 60_000, second]);
  await orders.finishOrder(second);
  assert.equal((await status(second)).status, "failed");
  assert.equal(cancels(), 1);
});

test("the limits: a name being bought, the daily cap, and the terms box", async () => {
  await startAndHold();
  const again = await orders.startDomainOrder(admin as never, "live", { domain: "goldencrumb.com", siteSlug: "crumb-1", contact, accepted: true }, "https://flash.test");
  assert.ok("error" in again);
  await run("DELETE FROM domain_orders");
  await run("DELETE FROM owned_domains");
  process.env.FLASH_DOMAIN_DAILY_CAP_USD = "5";
  const capped = await orders.startDomainOrder(admin as never, "live", { domain: "goldencrumb.com", siteSlug: "crumb-1", contact, accepted: true }, "https://flash.test");
  assert.ok("error" in capped && capped.status === 429);
  delete process.env.FLASH_DOMAIN_DAILY_CAP_USD;
  const unticked = await orders.startDomainOrder(admin as never, "live", { domain: "goldencrumb.com", siteSlug: "crumb-1", contact }, "https://flash.test");
  assert.ok("error" in unticked && unticked.status === 400);
  const notTheirs = await orders.startDomainOrder(other as never, "live", { domain: "goldencrumb.com", siteSlug: "crumb-1", contact, accepted: true }, "https://flash.test");
  assert.ok("error" in notTheirs && notTheirs.status === 404);
});

test("in Name.com's sandbox nothing is paid: the order goes straight to buying", async () => {
  process.env.NAMECOM_MODE = "";
  const started = await orders.startDomainOrder(admin as never, "sandbox", { domain: "goldencrumb.com", siteSlug: "crumb-1", contact, accepted: true }, "https://flash.test");
  process.env.NAMECOM_MODE = "live";
  assert.ok("order" in started && !("url" in started));
  for (let i = 0; i < 20 && (await status(started.order)).status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await status(started.order)).status, "done");
  assert.equal(count((c) => c.url.startsWith("https://api.stripe.com")), 0);
  assert.equal(count((c) => c.url.startsWith("https://api.vercel.com")), 0, "a sandbox domain isn't real, so it stays off Vercel");
  const buy = fake.calls.find((c) => c.method === "POST" && c.url === "https://api.dev.name.com/core/v1/domains")!;
  assert.equal(buy.headers.get("authorization"), `Basic ${Buffer.from("AI-Flash-Inc-test:test-token").toString("base64")}`);
});
