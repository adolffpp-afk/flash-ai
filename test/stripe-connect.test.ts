import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);
process.env.DATABASE_URL = ":memory:";
// A live key: Stripe also sends a live Connect endpoint its connected accounts' test-mode events.
process.env.STRIPE_SECRET_KEY = "sk_live_flash";
process.env.RESEND_API_KEY = "re_test";
delete process.env.FLASH_APP_URL;
const SECRET = "whsec_connect_test";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET;
console.error = () => {};
console.warn = () => {};
const { run, one } = await import("../src/lib/server/db.ts");
const shop = await import("../src/lib/server/shop.ts");
const { funnelStats } = await import("../src/lib/server/funnel.ts");
const { contactDetail, exportContact } = await import("../src/lib/server/contacts.ts");
const { forgetServerMemory, pruneDaily } = await import("../src/lib/server/visits.ts");
const { unpublishSite } = await import("../src/lib/server/sites.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const connectRoute = await import("../src/app/api/stripe/connect/route.ts");
const ordersRoute = await import("../src/app/api/sites/[slug]/orders/route.ts");

const ORIGIN = "https://www.flash-app.dev";
const nowSec = () => Math.floor(Date.now() / 1000);
/** Stripe's scheme, as verifyWebhook checks it: t=<seconds>,v1=<HMAC-SHA256 of "<t>.<body>">. */
const sign = (payload: string, t = nowSec(), key = SECRET) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${payload}`).digest("hex")}`;
const deliver = (payload: string, header: string | null = sign(payload)) =>
  connectRoute.POST(
    new Request(`${ORIGIN}/api/stripe/connect`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json", ...(header === null ? {} : { "stripe-signature": header }) },
    }),
  );
let serial = 0;
type Event = { id?: string; type: string; account?: string; livemode?: unknown; created?: number; data: { object: Record<string, unknown> } };
const event = (type: string, object: Record<string, unknown>, extra: Partial<Event> = {}): Event => ({
  id: `evt_${++serial}`,
  type,
  account: "acct_A",
  livemode: true,
  created: 1_760_000_000 + serial,
  data: { object },
  ...extra,
});
/** Sends the event signed, and gives back the status and what the webhook said it did. */
async function send(e: Event): Promise<{ status: number; outcome?: string }> {
  const res = await deliver(JSON.stringify(e));
  const body = res.status === 200 ? ((await res.json()) as { outcome: string }) : null;
  return { status: res.status, outcome: body?.outcome };
}
const n = async (sql: string, args: (string | number)[] = []) => Number((await one<{ n: number }>(sql, args))?.n ?? 0);
const order = (id: string) =>
  one<{ site_slug: string; quantity: number; refunded_amount: number; refunded_at: number; disputed_at: number }>(
    "SELECT site_slug, quantity, refunded_amount, refunded_at, disputed_at FROM site_orders WHERE session_id = ?",
    [id],
  );

// Stripe, as each connected account sees it: its checkout sessions, and its charges' payments.
type Session = Record<string, unknown> & { id: string; payment_intent?: string };
const accounts: Record<string, Session[]> = { acct_A: [], acct_B: [], acct_C: [] };
const charges: Record<string, string> = {};
const calls: { path: string; account?: string }[] = [];
const emails: { to: string[]; subject: string }[] = [];
let stripeDown = false;
const paid = (id: string, pi: string, slug = "cake-1", extra: Record<string, unknown> = {}): Session => ({
  id,
  object: "checkout.session",
  livemode: true,
  payment_status: "paid",
  amount_total: 2500,
  currency: "cad",
  created: nowSec(),
  payment_intent: pi,
  metadata: { flash_site: slug, flash_item: "Cake" },
  customer_details: { email: `${id}@example.com`, name: "Ana" },
  line_items: { data: [{ quantity: 2 }] },
  ...extra,
});
/** What an event carries: the session without its line items, as Stripe sends it. */
const sent = (s: Session) => {
  const copy: Record<string, unknown> = { ...s };
  delete copy.line_items;
  return copy;
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
    emails.push({ to: body.to, subject: body.subject });
    return Response.json({ id: "email" });
  }
  const path = url.pathname.replace("/v1", "");
  const account = ((init?.headers ?? {}) as Record<string, string>)["Stripe-Account"];
  calls.push({ path: path + url.search, account });
  if (stripeDown) return Response.json({ error: { message: "Stripe is down" } }, { status: 500 });
  const sessions = accounts[account] ?? [];
  if (path.startsWith("/checkout/sessions/")) {
    const found = sessions.find((s) => s.id === decodeURIComponent(path.split("/")[3]));
    return found ? Response.json(found) : Response.json({ error: { message: "No such checkout.session" } }, { status: 404 });
  }
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    return Response.json({ data: pi ? sessions.filter((s) => s.payment_intent === pi).slice(0, 1) : sessions });
  }
  if (path.startsWith("/charges/")) {
    const pi = charges[`${account}:${path.split("/")[2]}`];
    return pi ? Response.json({ id: path.split("/")[2], payment_intent: pi }) : Response.json({ error: { message: "No such charge" } }, { status: 404 });
  }
  return Response.json({ error: { message: `unexpected ${path}` } }, { status: 400 });
}) as typeof fetch;

await run(
  "INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('u1', 'owner@x.co', 'h', 0, 1), ('u2', 'other@x.co', 'h', 0, 1)",
);
await run(
  "INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('cake-1', 'u1', 'Crumb', '<p>', 0, 0), ('shop-b', 'u2', 'Other shop', '<p>', 0, 0)",
);
await run(
  "INSERT INTO seller_accounts (user_id, stripe_account, country, currency, ready, created_at) VALUES ('u1', 'acct_A', 'CA', 'cad', 1, 0), ('u2', 'acct_B', 'CA', 'cad', 1, 0)",
);

test("without STRIPE_CONNECT_WEBHOOK_SECRET the webhook refuses everything, and nothing changes", async () => {
  accounts.acct_A.push(paid("cs_unset", "pi_unset"));
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  try {
    for (const header of [sign("{}"), null]) {
      const e = event("checkout.session.completed", sent(paid("cs_unset", "pi_unset")));
      const res = await deliver(JSON.stringify(e), header && sign(JSON.stringify(e)));
      assert.equal(res.status, 503);
    }
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "  ";
    assert.equal((await send(event("checkout.session.completed", sent(paid("cs_unset", "pi_unset"))))).status, 503, "a blank secret is no secret");
  } finally {
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET;
  }
  assert.equal(calls.length, 0, "Stripe isn't asked anything");
  assert.equal(await order("cs_unset"), null);
  assert.equal(await n("SELECT COUNT(*) AS n FROM stripe_events"), 0);
  // The other two ways still save orders as before.
  const back = await shop.finishCheckout("cake-1", "cs_unset", null, ORIGIN);
  assert.equal(back.paid, true);
  assert.ok(await order("cs_unset"));
});

test("only Stripe's signature over the body as sent, made in the last 5 minutes, is accepted", async () => {
  accounts.acct_A.push(paid("cs_sig", "pi_sig"));
  const e = event("checkout.session.completed", sent(paid("cs_sig", "pi_sig")));
  const body = JSON.stringify(e);
  const before = calls.length;
  const refused: [string, string | null, string][] = [
    ["missing", null, body],
    ["empty", "", body],
    ["another secret", sign(body, nowSec(), "whsec_someone_else"), body],
    ["a changed body", sign(body), body.replace("cs_sig", "cs_sig2")],
    ["stale (6 minutes old)", sign(body, nowSec() - 360), body],
    ["from the future", sign(body, nowSec() + 360), body],
    ["no v1", `t=${nowSec()},v0=${createHmac("sha256", SECRET).update(`${nowSec()}.${body}`).digest("hex")}`, body],
    ["cut short", sign(body).slice(0, -2), body],
  ];
  for (const [why, header, payload] of refused) {
    const res = await deliver(payload, header);
    assert.equal(res.status, 400, why);
  }
  assert.equal(calls.length, before, "a refused call asks Stripe nothing");
  assert.equal(await order("cs_sig"), null, "and saves nothing");
  // Signed, but not an event.
  assert.equal((await deliver("not json", sign("not json"))).status, 400);
  assert.equal((await deliver("null", sign("null"))).status, 400);
  // Signed with the secret, a minute old, with an older signature beside it (Stripe sends both while a secret rolls).
  const t = nowSec() - 60;
  const header = `t=${t},v1=${"0".repeat(64)},${sign(body, t).split(",")[1]}`;
  const ok = await deliver(body, header);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { received: true, outcome: "recorded" });
  assert.equal((await order("cs_sig"))?.quantity, 2, "what was bought is read from Stripe, on the seller's account");
  assert.deepEqual(calls.at(-1), { path: "/checkout/sessions/cs_sig?expand[]=line_items", account: "acct_A" });
});

test("a paid checkout is one order, new once, through the webhook, the return page and the owner's sync, in any order", async () => {
  emails.length = 0;
  // The buyer closed the tab: the webhook saves the order and emails the owner.
  accounts.acct_A.push(paid("cs_one", "pi_one"));
  await run("INSERT INTO site_checkouts (session_id, site_slug, source, medium, campaign, created_at) VALUES ('cs_one', 'cake-1', 'instagram', '', '', ?)", [Date.now()]);
  assert.deepEqual(await send(event("checkout.session.completed", sent(paid("cs_one", "pi_one")))), { status: 200, outcome: "recorded" });
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ["owner@x.co"]);
  assert.match(emails[0].subject, /New order on your site Crumb/);
  // The buyer comes back after all, the owner opens Orders, and Stripe sends the paid-later event too.
  assert.deepEqual(await shop.finishCheckout("cake-1", "cs_one", null, ORIGIN), { page: `${ORIGIN}/p/cake-1`, paid: true });
  await shop.syncOrders("u1", "cake-1");
  assert.deepEqual(await send(event("checkout.session.async_payment_succeeded", sent(paid("cs_one", "pi_one")))), { status: 200, outcome: "unchanged" });
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_orders WHERE session_id = 'cs_one'"), 1, "one order");
  assert.equal(emails.length, 1, "one email to the owner");
  // Where order.paid starts its one run (order:<sessionId>): the order counted once, under its source.
  assert.equal(await n("SELECT SUM(orders) AS n FROM site_revenue WHERE site_slug = 'cake-1' AND source = 'instagram'"), 1);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_contacts WHERE site_slug = 'cake-1' AND email = 'cs_one@example.com'"), 1);

  // The other way round: the buyer is back first, and the webhook comes after.
  accounts.acct_A.push(paid("cs_two", "pi_two"));
  await shop.finishCheckout("cake-1", "cs_two", null, ORIGIN);
  assert.equal(emails.length, 2);
  assert.deepEqual(await send(event("checkout.session.completed", sent(paid("cs_two", "pi_two")))), { status: 200, outcome: "unchanged" });
  assert.equal(emails.length, 2, "no second email");
  // And the owner's sync first, then both.
  accounts.acct_A.push(paid("cs_three", "pi_three"));
  await shop.syncOrders("u1", "cake-1");
  assert.ok(await order("cs_three"));
  assert.deepEqual(await send(event("checkout.session.completed", sent(paid("cs_three", "pi_three")))), { status: 200, outcome: "unchanged" });
  await shop.finishCheckout("cake-1", "cs_three", null, ORIGIN);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_orders WHERE session_id = 'cs_three'"), 1);
  assert.equal(emails.length, 2, "an order the sync found sends nothing more");
});

test("a bank debit's checkout is saved when it is paid, days later", async () => {
  emails.length = 0;
  const later = paid("cs_debit", "pi_debit", "cake-1", { payment_status: "unpaid" });
  accounts.acct_A.push(later);
  assert.deepEqual(await send(event("checkout.session.completed", sent(later))), { status: 200, outcome: "unpaid" });
  assert.equal(await order("cs_debit"), null);
  later.payment_status = "paid";
  assert.deepEqual(await send(event("checkout.session.async_payment_succeeded", sent(later))), { status: 200, outcome: "recorded" });
  assert.ok(await order("cs_debit"));
  assert.equal(emails.length, 1);
});

test("the same event is handled once: sent again, it changes nothing and asks Stripe nothing", async () => {
  accounts.acct_A.push(paid("cs_replay", "pi_replay"));
  const e = event("checkout.session.completed", sent(paid("cs_replay", "pi_replay")));
  assert.equal((await send(e)).outcome, "recorded");
  assert.equal(await n("SELECT COUNT(*) AS n FROM stripe_events WHERE id = ?", [e.id!]), 1);
  // A partial refund, then the full one, then the partial one sent again (a replay, or Stripe's retry).
  const partial = event("charge.refunded", { id: "ch_replay", object: "charge", amount: 2500, amount_refunded: 500, refunded: false, payment_intent: "pi_replay" });
  assert.equal((await send(partial)).outcome, "refunded");
  const full = event("charge.refunded", { id: "ch_replay", object: "charge", amount: 2500, amount_refunded: 2500, refunded: true, payment_intent: "pi_replay" });
  assert.equal((await send(full)).outcome, "refunded");
  const before = calls.length;
  assert.deepEqual(await send(e), { status: 200, outcome: "duplicate" });
  assert.deepEqual(await send(partial), { status: 200, outcome: "duplicate" });
  assert.equal(calls.length, before, "Stripe isn't asked again");
  assert.equal((await order("cs_replay"))?.refunded_amount, 2500, "the full refund stays");
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_orders WHERE session_id = 'cs_replay'"), 1);
});

test("an event is only for an app whose owner's connected account sent it", async () => {
  const kept = await n("SELECT COUNT(*) AS n FROM stripe_events");
  // Another seller's account, sending a checkout that names this app (made with their own Stripe dashboard).
  accounts.acct_B.push(paid("cs_b_names_a", "pi_b1", "cake-1"));
  assert.deepEqual(await send(event("checkout.session.completed", sent(paid("cs_b_names_a", "pi_b1", "cake-1")), { account: "acct_B" })), {
    status: 200,
    outcome: "not-ours",
  });
  assert.equal(await order("cs_b_names_a"), null);
  // This app's account, with a session naming another owner's app.
  accounts.acct_A.push(paid("cs_a_names_b", "pi_a9", "shop-b"));
  assert.equal((await send(event("checkout.session.completed", sent(paid("cs_a_names_b", "pi_a9", "shop-b"))))).outcome, "not-ours");
  assert.equal(await order("cs_a_names_b"), null);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_orders WHERE site_slug = 'shop-b'"), 0);
  // The seller's own sales outside Flash, with no app named.
  accounts.acct_A.push({ ...paid("cs_elsewhere", "pi_elsewhere"), metadata: {} });
  assert.equal((await send(event("checkout.session.completed", sent({ ...paid("cs_elsewhere", "pi_elsewhere"), metadata: {} })))).outcome, "not-ours");
  // An account Flash never connected, and one not ready to sell: Stripe isn't asked.
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u3', 'new@x.co', 'h', 0)");
  await run("INSERT INTO seller_accounts (user_id, stripe_account, country, currency, ready, created_at) VALUES ('u3', 'acct_C', 'CA', 'cad', 0, 0)");
  const before = calls.length;
  for (const account of ["acct_Z", "acct_C"]) {
    assert.equal((await send(event("checkout.session.completed", sent(paid("cs_z", "pi_z")), { account }))).outcome, "not-ours", account);
    assert.equal((await send(event("charge.refunded", { id: "ch_z", amount: 2500, amount_refunded: 2500, payment_intent: "pi_z" }, { account }))).outcome, "not-ours", account);
    assert.equal((await send(event("charge.dispute.created", { id: "dp_z", charge: "ch_z" }, { account }))).outcome, "not-ours", account);
  }
  // Flash's own account (no account on the event) and a made-up one.
  for (const account of [undefined, "acct_A; DROP", ""]) {
    assert.equal((await send(event("checkout.session.completed", sent(paid("cs_z", "pi_z")), { account }))).outcome, "ignored", String(account));
  }
  assert.equal(calls.length, before);

  // A refund another account sends for a payment whose session names this app changes nothing.
  accounts.acct_A.push(paid("cs_keep", "pi_keep"));
  await shop.finishCheckout("cake-1", "cs_keep", null, ORIGIN);
  accounts.acct_B.push({ ...paid("cs_keep", "pi_keep_b"), metadata: { flash_site: "cake-1", flash_item: "Cake" } });
  const foreign = { id: "ch_b", object: "charge", amount: 2500, amount_refunded: 2500, refunded: true, payment_intent: "pi_keep_b" };
  assert.equal((await send(event("charge.refunded", foreign, { account: "acct_B" }))).outcome, "not-ours");
  assert.equal(await send(event("charge.dispute.created", { id: "dp_b", object: "dispute", charge: "ch_b", payment_intent: "pi_keep_b" }, { account: "acct_B" })).then((r) => r.outcome), "not-ours");
  assert.deepEqual({ ...(await order("cs_keep")) }, { site_slug: "cake-1", quantity: 2, refunded_amount: 0, refunded_at: 0, disputed_at: 0 });
  assert.equal(await n("SELECT COUNT(*) AS n FROM stripe_events"), kept, "events that change nothing write nothing");
});

test("a test-mode event never becomes a paid order in live mode, nor a live one under a test key", async () => {
  emails.length = 0;
  const testSession = paid("cs_test_mode", "pi_test_mode", "cake-1", { livemode: false });
  accounts.acct_A.push(testSession);
  const before = calls.length;
  for (const livemode of [false, undefined, "true", 1]) {
    assert.deepEqual(await send(event("checkout.session.completed", sent(testSession), { livemode })), { status: 200, outcome: "ignored" }, String(livemode));
    assert.equal((await send(event("charge.refunded", { id: "ch_t", amount: 2500, amount_refunded: 2500, payment_intent: "pi_keep" }, { livemode }))).outcome, "ignored");
  }
  assert.equal(calls.length, before, "Stripe isn't asked about them");
  assert.equal((await order("cs_keep"))?.refunded_amount, 0, "a test-mode refund doesn't touch a live order");
  // A live event whose session Stripe says is a test one: recordOrder checks the session itself.
  assert.equal((await send(event("checkout.session.completed", { ...sent(testSession), livemode: true }))).outcome, "unchanged");
  // The return page and the owner's sync check the session's mode too.
  assert.deepEqual(await shop.finishCheckout("cake-1", "cs_test_mode", null, ORIGIN), { page: `${ORIGIN}/p/cake-1`, paid: false });
  await shop.syncOrders("u1", "cake-1");
  assert.equal(await order("cs_test_mode"), null);
  assert.equal(emails.length, 0);
  // Under a test key, it's the other way round.
  process.env.STRIPE_SECRET_KEY = "rk_test_flash";
  try {
    accounts.acct_A.push(paid("cs_live_under_test", "pi_lut"));
    assert.equal((await send(event("checkout.session.completed", sent(paid("cs_live_under_test", "pi_lut"))))).outcome, "ignored");
    assert.equal((await send(event("checkout.session.completed", sent(paid("cs_live_under_test", "pi_lut")), { livemode: false }))).outcome, "unchanged");
    const testToo = paid("cs_test_too", "pi_test_too", "cake-1", { livemode: false });
    accounts.acct_A.push(testToo);
    assert.equal((await send(event("checkout.session.completed", sent(testToo), { livemode: false }))).outcome, "recorded");
    await shop.syncOrders("u1", "cake-1");
    assert.equal(await order("cs_live_under_test"), null);
    assert.ok(await order("cs_test_mode"), "the sync saves the test key's own mode");
  } finally {
    process.env.STRIPE_SECRET_KEY = "sk_live_flash";
    await run("DELETE FROM site_orders WHERE session_id IN ('cs_test_mode', 'cs_test_too')");
  }
});

test("refunds, in part and in full, and disputes are kept with the order, and the owner sees a plain label", async () => {
  accounts.acct_A.push(paid("cs_ref", "pi_ref"));
  await shop.finishCheckout("cake-1", "cs_ref", null, ORIGIN);
  const charge = { id: "ch_ref", object: "charge", amount: 2500, refunded: false, payment_intent: "pi_ref" };
  const partial = event("charge.refunded", { ...charge, amount_refunded: 500 });
  assert.deepEqual(await send(partial), { status: 200, outcome: "refunded" });
  assert.deepEqual(calls.at(-1), { path: "/checkout/sessions?payment_intent=pi_ref&limit=1&expand%5B%5D=data.line_items", account: "acct_A" });
  assert.deepEqual({ ...(await order("cs_ref")) }, { site_slug: "cake-1", quantity: 2, refunded_amount: 500, refunded_at: partial.created! * 1000, disputed_at: 0 });
  let listed = (await shop.listOrders("u1", "cake-1")).find((o) => o.id === "cs_ref")!;
  assert.deepEqual([listed.refund, listed.refunded, listed.disputed], ["part", "CA$5.00", false]);
  // Each refund comes with the charge's total refunded so far; one sent late never lowers it.
  const more = event("charge.refunded", { ...charge, amount_refunded: 1500 });
  const late = event("charge.refunded", { ...charge, amount_refunded: 500 }, { created: more.created! - 100 });
  assert.equal((await send(more)).outcome, "refunded");
  assert.equal((await send(late)).outcome, "refunded");
  assert.deepEqual([(await order("cs_ref"))?.refunded_amount, (await order("cs_ref"))?.refunded_at], [1500, more.created! * 1000]);
  const full = event("charge.refunded", { ...charge, amount_refunded: 2500, refunded: true });
  await send(full);
  listed = (await shop.listOrders("u1", "cake-1")).find((o) => o.id === "cs_ref")!;
  assert.deepEqual([listed.refund, listed.refunded], ["full", "CA$25.00"]);
  // A refund can't be more than the order.
  accounts.acct_A.push(paid("cs_over", "pi_over"));
  await shop.finishCheckout("cake-1", "cs_over", null, ORIGIN);
  await send(event("charge.refunded", { id: "ch_over", amount: 9000, amount_refunded: 9000, payment_intent: "pi_over" }));
  assert.equal((await order("cs_over"))?.refunded_amount, 2500);

  // A dispute, once: a second event for it keeps the first time.
  accounts.acct_A.push(paid("cs_disp", "pi_disp"));
  await shop.finishCheckout("cake-1", "cs_disp", null, ORIGIN);
  const dispute = event("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_disp", payment_intent: "pi_disp", amount: 2500 });
  assert.deepEqual(await send(dispute), { status: 200, outcome: "disputed" });
  await send(event("charge.dispute.created", { id: "dp_2", object: "dispute", charge: "ch_disp", payment_intent: "pi_disp", amount: 2500 }));
  assert.equal((await order("cs_disp"))?.disputed_at, dispute.created! * 1000);
  // A dispute from an older API version names only its charge.
  accounts.acct_A.push(paid("cs_disp_old", "pi_disp_old"));
  charges["acct_A:ch_old"] = "pi_disp_old";
  await shop.finishCheckout("cake-1", "cs_disp_old", null, ORIGIN);
  assert.equal((await send(event("charge.dispute.created", { id: "dp_3", object: "dispute", charge: "ch_old", payment_intent: null }))).outcome, "disputed");
  assert.ok((await order("cs_disp_old"))?.disputed_at);
  listed = (await shop.listOrders("u1", "cake-1")).find((o) => o.id === "cs_disp")!;
  assert.deepEqual([listed.refund, listed.disputed], ["", true]);

  // The owner's spreadsheet says the same.
  const cookie = (await createSession("u1", true)).split(";")[0];
  const csv = await (await ordersRoute.GET(new Request(`${ORIGIN}/api/sites/cake-1/orders`, { headers: { cookie } }), { params: Promise.resolve({ slug: "cake-1" }) } as never)).text();
  const rows = csv.split("\r\n");
  assert.match(rows[0], /,Refunds and disputes,Stripe checkout$/);
  assert.match(rows.find((r) => r.endsWith(",cs_ref"))!, /,Refunded,cs_ref$/);
  assert.match(rows.find((r) => r.endsWith(",cs_disp"))!, /,Disputed,cs_disp$/);
  assert.match(rows.find((r) => r.endsWith(",cs_one"))!, /,No,,cs_one$/);
  // A partial refund and a dispute together.
  accounts.acct_A.push(paid("cs_both", "pi_both"));
  await shop.finishCheckout("cake-1", "cs_both", null, ORIGIN);
  await send(event("charge.refunded", { id: "ch_both", amount: 2500, amount_refunded: 1000, payment_intent: "pi_both" }));
  await send(event("charge.dispute.created", { id: "dp_both", charge: "ch_both", payment_intent: "pi_both" }));
  const both = await (await ordersRoute.GET(new Request(`${ORIGIN}/api/sites/cake-1/orders`, { headers: { cookie } }), { params: Promise.resolve({ slug: "cake-1" }) } as never)).text();
  assert.match(both, /,Partly refunded: CA\$10\.00; Disputed,cs_both\r\n/);

  // So do the buyer's contact card and the export of everything kept about them.
  const contactOf = async (email: string) => (await one<{ id: string }>("SELECT id FROM site_contacts WHERE site_slug = 'cake-1' AND email = ?", [email]))!.id;
  const card = (await contactDetail("cake-1", await contactOf("cs_both@example.com"), ORIGIN))!;
  assert.deepEqual(
    card.orders.map((o) => [o.id, o.refund, o.refunded, o.disputed]),
    [["cs_both", "part", "CA$10.00", true]],
  );
  assert.deepEqual(
    (await contactDetail("cake-1", await contactOf("cs_ref@example.com"), ORIGIN))!.orders.map((o) => [o.refund, o.refunded, o.disputed]),
    [["full", "CA$25.00", false]],
  );
  assert.deepEqual(
    (await contactDetail("cake-1", await contactOf("cs_one@example.com"), ORIGIN))!.orders.map((o) => [o.refund, o.refunded, o.disputed]),
    [["", "", false]],
  );
  const exported = (await exportContact("cake-1", await contactOf("cs_both@example.com"), ORIGIN))!;
  assert.deepEqual(
    (exported.orders as { refund: string; refunded: string; disputed: boolean }[]).map((o) => [o.refund, o.refunded, o.disputed]),
    [["part", "CA$10.00", true]],
  );
});

test("a payment refunded or disputed before its order was saved is saved then, already refunded or disputed, without a new-order email", async () => {
  emails.length = 0;
  // What each new order held the moment it was inserted, before anything updated it: a new order is
  // where order.paid starts (PR 3a), so one a refund or a dispute saves must never look like a plain sale.
  await run("CREATE TABLE inserted (session_id TEXT, refunded_amount INTEGER, refunded_at INTEGER, disputed_at INTEGER)");
  await run(
    "CREATE TRIGGER orders_inserted AFTER INSERT ON site_orders BEGIN INSERT INTO inserted VALUES (NEW.session_id, NEW.refunded_amount, NEW.refunded_at, NEW.disputed_at); END",
  );
  const inserted = (id: string) => one<{ refunded_amount: number; refunded_at: number; disputed_at: number }>("SELECT refunded_amount, refunded_at, disputed_at FROM inserted WHERE session_id = ?", [id]);
  try {
    accounts.acct_A.push(paid("cs_early", "pi_early"));
    const refund = event("charge.refunded", { id: "ch_early", amount: 2500, amount_refunded: 2500, refunded: true, payment_intent: "pi_early" });
    assert.equal((await send(refund)).outcome, "refunded");
    const refunded = { refunded_amount: 2500, refunded_at: refund.created! * 1000, disputed_at: 0 };
    assert.deepEqual({ ...(await order("cs_early")) }, { site_slug: "cake-1", quantity: 2, ...refunded });
    assert.deepEqual({ ...(await inserted("cs_early")) }, refunded, "saved refunded, in the same INSERT");
    // A refund of part of it, and more than the order (capped), the same way.
    accounts.acct_A.push(paid("cs_early_part", "pi_early_part"), paid("cs_early_over", "pi_early_over"));
    const part = event("charge.refunded", { id: "ch_early_part", amount: 2500, amount_refunded: 700, payment_intent: "pi_early_part" });
    await send(part);
    assert.deepEqual({ ...(await inserted("cs_early_part")) }, { refunded_amount: 700, refunded_at: part.created! * 1000, disputed_at: 0 });
    await send(event("charge.refunded", { id: "ch_early_over", amount: 9000, amount_refunded: 9000, payment_intent: "pi_early_over" }));
    assert.equal((await inserted("cs_early_over"))?.refunded_amount, 2500);
    // A dispute first: saved disputed.
    accounts.acct_A.push(paid("cs_early_disp", "pi_early_disp"));
    const dispute = event("charge.dispute.created", { id: "dp_early", object: "dispute", charge: "ch_early_disp", payment_intent: "pi_early_disp" });
    assert.equal((await send(dispute)).outcome, "disputed");
    const disputed = { refunded_amount: 0, refunded_at: 0, disputed_at: dispute.created! * 1000 };
    assert.deepEqual({ ...(await inserted("cs_early_disp")) }, disputed, "saved disputed, in the same INSERT");
    assert.deepEqual({ ...(await order("cs_early_disp")) }, { site_slug: "cake-1", quantity: 2, ...disputed });
    // Still a sale that was made: its buyer is a contact, and it counts as paid (with its refund on its own line).
    assert.equal(await n("SELECT COUNT(*) AS n FROM site_contacts WHERE site_slug = 'cake-1' AND email IN ('cs_early@example.com', 'cs_early_disp@example.com')"), 2);
    assert.equal(emails.length, 0);
    // A paid order saved the usual way is inserted with nothing refunded or disputed.
    accounts.acct_A.push(paid("cs_plain", "pi_plain"));
    await shop.finishCheckout("cake-1", "cs_plain", null, ORIGIN);
    assert.deepEqual({ ...(await inserted("cs_plain")) }, { refunded_amount: 0, refunded_at: 0, disputed_at: 0 });
    assert.equal(emails.length, 1);
    emails.length = 0;
  } finally {
    await run("DROP TRIGGER orders_inserted");
    await run("DROP TABLE inserted");
  }
  // The checkout event coming after is the same order, and still no email.
  assert.equal((await send(event("checkout.session.completed", sent(paid("cs_early", "pi_early"))))).outcome, "unchanged");
  assert.equal((await send(event("checkout.session.async_payment_succeeded", sent(paid("cs_early_disp", "pi_early_disp"))))).outcome, "unchanged");
  assert.equal(emails.length, 0);
  assert.equal((await order("cs_early"))?.refunded_amount, 2500);
  // A refund of a sale Flash didn't make (no session for it) changes nothing.
  assert.equal((await send(event("charge.refunded", { id: "ch_x", amount: 900, amount_refunded: 900, payment_intent: "pi_not_flash" }))).outcome, "not-ours");
  assert.equal((await send(event("charge.refunded", { id: "ch_y", amount: 900, amount_refunded: 900 }))).outcome, "not-ours");
});

test("the funnel keeps Paid and Revenue as what buyers paid, and says what was refunded on its own line", async () => {
  const stats = (await funnelStats("cake-1", 7))!;
  const orders = await n("SELECT COUNT(*) AS n FROM site_orders WHERE site_slug = 'cake-1'");
  assert.equal(stats.totals.orders, orders, "a refunded order is still an order that was paid");
  assert.deepEqual(stats.totals.revenue, [{ currency: "cad", amount: orders * 2500 }]);
  const refunded = await n("SELECT SUM(refunded_amount) AS n FROM site_orders WHERE site_slug = 'cake-1'");
  assert.deepEqual(stats.refunded, {
    orders: await n("SELECT COUNT(*) AS n FROM site_orders WHERE site_slug = 'cake-1' AND refunded_amount > 0"),
    revenue: [{ currency: "cad", amount: refunded }],
  });
  assert.ok(stats.refunded.orders >= 4 && refunded >= 2500 * 3);
  assert.deepEqual((await funnelStats("shop-b", 7))!.refunded, { orders: 0, revenue: [] });
});

test("events it doesn't handle are answered 200 at once, and change nothing", async () => {
  const before = { calls: calls.length, events: await n("SELECT COUNT(*) AS n FROM stripe_events") };
  for (const type of ["payment_intent.succeeded", "charge.succeeded", "account.updated", "checkout.session.expired", "charge.dispute.closed", "charge.refund.updated"]) {
    assert.deepEqual(await send(event(type, { id: "x_1" })), { status: 200, outcome: "ignored" }, type);
  }
  // Nor ones that aren't Stripe's shape.
  for (const odd of [{ type: "charge.refunded", data: {} }, { type: "charge.refunded", id: "nope", data: { object: {} } }, { id: "evt_9", data: { object: {} } }]) {
    const body = JSON.stringify({ account: "acct_A", livemode: true, ...odd });
    const res = await deliver(body);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { outcome: string }).outcome, "ignored");
  }
  assert.equal(calls.length, before.calls);
  assert.equal(await n("SELECT COUNT(*) AS n FROM stripe_events"), before.events);
});

test("when Stripe fails the webhook answers 500, keeps nothing, and handles the event when Stripe sends it again", async () => {
  emails.length = 0;
  accounts.acct_A.push(paid("cs_retry", "pi_retry"));
  const e = event("checkout.session.completed", sent(paid("cs_retry", "pi_retry")));
  stripeDown = true;
  try {
    assert.equal((await send(e)).status, 500);
  } finally {
    stripeDown = false;
  }
  assert.equal(await order("cs_retry"), null);
  assert.equal(await n("SELECT COUNT(*) AS n FROM stripe_events WHERE id = ?", [e.id!]), 0, "not kept as handled");
  assert.deepEqual(await send(e), { status: 200, outcome: "recorded" });
  assert.equal(emails.length, 1);
});

test("handled events are forgotten after 30 days, and an unpublished app's orders don't come back", async () => {
  const day = 86_400_000;
  const at = Date.now() + 2 * day;
  await run("INSERT INTO stripe_events (id, created_at) VALUES ('evt_old', ?), ('evt_recent', ?)", [at - 31 * day, at - 29 * day]);
  forgetServerMemory();
  assert.equal(await pruneDaily(at), true);
  assert.equal(await n("SELECT COUNT(*) AS n FROM stripe_events WHERE id = 'evt_old'"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM stripe_events WHERE id = 'evt_recent'"), 1);

  assert.equal(await unpublishSite("u1", "cake-1"), true);
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_orders WHERE site_slug = 'cake-1'"), 0);
  assert.equal((await send(event("charge.refunded", { id: "ch_gone", amount: 2500, amount_refunded: 2500, payment_intent: "pi_one" }))).outcome, "not-ours");
  assert.equal((await send(event("checkout.session.completed", sent(paid("cs_one", "pi_one"))))).outcome, "not-ours");
  assert.equal(await n("SELECT COUNT(*) AS n FROM site_orders"), 0, "nothing comes back for an app that is gone");
});
