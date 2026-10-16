import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.STRIPE_SECRET_KEY = "rk_test";
const { run } = await import("../src/lib/server/db.ts");
const { balance } = await import("../src/lib/server/credits.ts");
const { autoTopUp, setAutoTopUp, saveCard, maybeAutoTopUp, MAX_PER_MONTH } = await import("../src/lib/server/auto-topup.ts");

type Call = { method: string; path: string; body: URLSearchParams };
let calls: Call[] = [];
let decline = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace("/v1", "");
  const body = new URLSearchParams(String(init?.body ?? ""));
  calls.push({ method: init?.method ?? "GET", path, body });
  if (path === "/customers") return Response.json({ id: "cus_new" });
  if (path === "/checkout/sessions" && init?.method === "POST") return Response.json({ url: "https://checkout.stripe.com/setup" });
  if (path.startsWith("/checkout/sessions/")) {
    return Response.json({ customer: "cus_new", metadata: { user: "u1", auto_topup: "1" }, setup_intent: { payment_method: "pm_1", status: "succeeded" } });
  }
  if (path.startsWith("/payment_methods/")) return Response.json({ billing_details: { address: { country: "CA", postal_code: "B3H 1A1", state: "NS", line1: null } } });
  if (path === "/tax/calculations") return Response.json({ id: "taxcalc_1", amount_total: Number(body.get("line_items[0][amount]")) + 75 });
  if (path === "/payment_intents") {
    if (decline) return Response.json({ error: { message: "Your card was declined." } }, { status: 402 });
    return Response.json({ id: `pi_${calls.length}`, status: "succeeded" });
  }
  return Response.json({});
}) as typeof fetch;

const user = { id: "u1", email: "u1@t.io" };
// Moves the last top-up back in time, past the 10 minutes between top-ups.
const later = () => run("UPDATE auto_topups SET last_at = 0");

test("turning auto top-up on first saves a card through Stripe, then it is on", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'u1@t.io', 'x', 0)");
  const res = await setAutoTopUp(user, { enabled: true, pack: "starter", below: 100 }, "https://flash.test");
  assert.equal(res.url, "https://checkout.stripe.com/setup");
  const setup = calls.find((c) => c.path === "/checkout/sessions")!;
  assert.equal(setup.body.get("mode"), "setup");
  assert.equal(setup.body.get("customer"), "cus_new");
  assert.equal((await autoTopUp("u1")).enabled, false, "not on until a card is saved");
  assert.equal(await saveCard("cs_1"), true);
  const s = await autoTopUp("u1");
  assert.equal(s.enabled, true);
  assert.equal(s.card, true);
  assert.equal(await setAutoTopUp(user, { enabled: true, pack: "nope", below: 100 }, "x").then((r) => r.error), "bad choice");
  assert.equal(await setAutoTopUp(user, { enabled: true, pack: "starter", below: 7 }, "x").then((r) => r.error), "bad choice");
});

test("a low balance buys the pack once, with gaps between top-ups and a monthly limit", async () => {
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u1', 150, 'test', 0)");
  calls = [];
  assert.equal(await maybeAutoTopUp("u1"), false, "150 isn't below 100");
  assert.equal(calls.length, 0);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u1', -100, 'spent', 0)");
  assert.equal(await maybeAutoTopUp("u1"), true);
  const pi = calls.find((c) => c.path === "/payment_intents")!;
  assert.equal(pi.body.get("amount"), "500");
  assert.equal(pi.body.get("off_session"), "true");
  assert.equal(pi.body.get("payment_method"), "pm_1");
  assert.equal(await balance("u1"), 550);
  // Spent again at once: no second top-up within 10 minutes.
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u1', -500, 'spent', 0)");
  assert.equal(await maybeAutoTopUp("u1"), false);
  for (let i = 1; i < MAX_PER_MONTH; i++) {
    await later();
    assert.equal(await maybeAutoTopUp("u1"), true, `top-up ${i + 1}`);
    await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u1', -500, 'spent', 0)");
  }
  await later();
  assert.equal(await maybeAutoTopUp("u1"), false, "the monthly limit");
  assert.equal((await autoTopUp("u1")).thisMonth, MAX_PER_MONTH);
  await run("DELETE FROM credit_ledger WHERE ref LIKE 'stripe:auto:%'");
});

test("sales tax is added on top when it's on, and recorded with Stripe", async () => {
  process.env.FLASH_STRIPE_TAX = "true";
  await later();
  calls = [];
  assert.equal(await maybeAutoTopUp("u1"), true);
  const calc = calls.find((c) => c.path === "/tax/calculations")!;
  assert.equal(calc.body.get("customer_details[address][country]"), "CA");
  assert.equal(calc.body.get("line_items[0][tax_behavior]"), "exclusive");
  assert.equal(calls.find((c) => c.path === "/payment_intents")!.body.get("amount"), "575");
  assert.ok(calls.some((c) => c.path === "/tax/transactions/create_from_calculation"));
  delete process.env.FLASH_STRIPE_TAX;
  await run("DELETE FROM credit_ledger WHERE ref LIKE 'stripe:auto:%'");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('u1', -500, 'spent', 0)");
});

test("a declined card turns auto top-up off and says why", async () => {
  await later();
  decline = true;
  assert.equal(await maybeAutoTopUp("u1"), false);
  const s = await autoTopUp("u1");
  assert.equal(s.enabled, false);
  assert.equal(s.failed, "Your card was declined.");
  decline = false;
  await later();
  assert.equal(await maybeAutoTopUp("u1"), false, "stays off until turned on again");
  await setAutoTopUp(user, { enabled: true, pack: "starter", below: 100 }, "x");
  assert.equal((await autoTopUp("u1")).failed, "", "turning it on clears the reason");
});
