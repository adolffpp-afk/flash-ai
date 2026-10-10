import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.FLASH_ADMIN_EMAILS = "owner@x.co";
process.env.GROQ_API_KEY = "gsk_never_shown_4821";
delete process.env.MISTRAL_API_KEY;
const { run, all } = await import("../src/lib/server/db.ts");
const { logUsage, findPurchase, recordReversal } = await import("../src/lib/server/credits.ts");
const { DISPUTE_FEE_CENTS, addFixedCost, fixedCostOver, fixedCosts, profitReport, readFixedCost, removeFixedCost } = await import(
  "../src/lib/server/profit.ts"
);
const { adminStats } = await import("../src/lib/server/admin-stats.ts");
const { PROVIDER_LIST, missingKeys, providerSetUp } = await import("../src/lib/providers.ts");
const { MODELS } = await import("../src/lib/models.ts");
const { FREE_PROVIDERS } = await import("../src/lib/server/free.ts");
const { paymentFeeCents } = await import("../src/lib/credits.ts");

const DAY = 24 * 3600_000;
const since = Date.now() - 30 * DAY;

await run(
  `INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES
   ('owner', 'owner@x.co', 'h', 0, 1), ('buyer', 'buyer@x.co', 'h', 0, 1)`,
);
await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES ('crumb-1', 'owner', 'Crumb', '<p>', 0, 0)");

test("every provider Flash can call is on the list, with its keys", () => {
  const ids = PROVIDER_LIST.map((p) => p.id);
  for (const m of MODELS) assert.ok(ids.includes(m.provider), `${m.provider} (${m.id}) is listed`);
  for (const p of FREE_PROVIDERS) assert.ok(ids.includes(p), `${p} is listed`);
  for (const id of ["anthropic", "fal", "openai", "elevenlabs"]) assert.ok(ids.includes(id), id);
  const anthropic = PROVIDER_LIST.find((p) => p.id === "anthropic")!;
  assert.equal(providerSetUp(anthropic, { ANTHROPIC_AUTH_TOKEN: "x" }), true, "either key will do");
  assert.equal(providerSetUp(anthropic, {}), false);
  const cloudflare = PROVIDER_LIST.find((p) => p.id === "cloudflare")!;
  assert.equal(providerSetUp(cloudflare, { CLOUDFLARE_API_TOKEN: "x" }), false, "both keys are needed");
  assert.equal(providerSetUp(cloudflare, { CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "y" }), true);
  assert.deepEqual(missingKeys(cloudflare, { CLOUDFLARE_ACCOUNT_ID: "y" }), ["CLOUDFLARE_API_TOKEN"], "names the one that's missing");
  assert.deepEqual(missingKeys(cloudflare, { CLOUDFLARE_ACCOUNT_ID: "y", CLOUDFLARE_API_TOKEN: "" }), ["CLOUDFLARE_API_TOKEN"], "an empty value is missing");
  assert.deepEqual(missingKeys(anthropic, {}), ["ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"]);
});

test("a request that used a helper logs each provider's share, and only one request", async () => {
  await logUsage({
    userId: "buyer",
    engine: "image",
    model: "flux-2-pro",
    provider: "fal",
    credits: 30,
    costCents: 10,
    ok: true,
    parts: [
      { provider: "anthropic", model: "claude-haiku", cents: 0.5 },
      { provider: "anthropic", model: "claude-haiku", cents: 0.5 },
      { provider: "fal", model: "flux-2-pro", cents: 9 },
    ],
  });
  const rows = await all<{ provider: string; model: string; credits: number; cost_cents: number; part: number }>(
    "SELECT provider, model, credits, cost_cents, part FROM usage WHERE user_id = 'buyer' ORDER BY part",
  );
  assert.deepEqual(
    rows.map((r) => [r.provider, r.model, Number(r.credits), Number(r.cost_cents), Number(r.part)]),
    [
      ["fal", "flux-2-pro", 30, 9, 0],
      ["anthropic", "claude-haiku", 0, 1, 1],
    ],
  );
  // A request with no helpers stays one row, as before.
  await logUsage({ userId: "buyer", engine: "text", model: "llama", provider: "groq", credits: 0, costCents: 0, ok: true });
  assert.equal((await all("SELECT 1 FROM usage WHERE user_id = 'buyer'")).length, 3);
});

test("a refund is counted once per event, and only what it newly took back", async () => {
  await run(
    `INSERT INTO purchases (user_id, pack, credits, amount_cents, test, ref, payment_intent, created_at) VALUES
     ('buyer', 'starter', 500, 500, 0, 'stripe:cs_1', 'pi_1', ?)`,
    [Date.now()],
  );
  const p = (await findPurchase({ paymentIntent: "pi_1" }))!;
  assert.equal(Number(p.test), 0);
  await recordReversal(p, "refund", "ch_r", 200, "stripe-refund:ch_r:200");
  await recordReversal(p, "refund", "ch_r", 200, "stripe-refund:ch_r:200");
  await recordReversal(p, "refund", "ch_r", 350, "stripe-refund:ch_r:350");
  // A late, older event adds nothing.
  await recordReversal(p, "refund", "ch_r", 300, "stripe-refund:ch_r:300");
  const rows = await all<{ amount_cents: number }>("SELECT amount_cents FROM payment_reversals WHERE charge = 'ch_r'");
  assert.equal(rows.reduce((sum, r) => sum + Number(r.amount_cents), 0), 350);
  await run("DELETE FROM payment_reversals");
  await run("DELETE FROM purchases");
});

test("bills are spread over the days shown", () => {
  assert.equal(fixedCostOver({ amountCents: 2000, per: "month" }, 30), Math.round(((2000 * 12) / 365) * 30));
  assert.equal(fixedCostOver({ amountCents: 3650, per: "year" }, 7), 70);
});

test("net profit takes refunds, disputes, Stripe fees, AI and bills off sales", async () => {
  await run("DELETE FROM usage");
  const at = Date.now() - DAY;
  await run(
    `INSERT INTO purchases (user_id, pack, credits, amount_cents, test, ref, created_at) VALUES
     ('buyer', 'plan:pro:month', 3000, 2000, 0, 'a', ?),
     ('buyer', 'starter', 500, 500, 0, 'b', ?),
     ('buyer', 'starter', 500, 999, 1, 'c', ?),
     ('buyer', 'starter', 500, 500, 0, 'd', ?)`,
    [at, at, at, since - DAY],
  );
  await run(
    `INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, created_at) VALUES
     ('cs_a', 'crumb-1', 'Bread', 1, 10000, 'usd', ?), ('cs_b', 'crumb-1', 'Bun', 1, 999, 'usd', ?),
     ('cs_c', 'crumb-1', 'Cake', 1, 5000, 'cad', ?)`,
    [at, at, at],
  );
  const buyer = { user_id: "buyer", pack: "starter", credits: 500, ref: "b", subscription: null, created_at: at, test: 0 };
  await recordReversal(buyer, "refund", "ch_1", 300, "r1");
  await recordReversal(buyer, "refund", "ch_1", 500, "r2");
  await recordReversal(buyer, "dispute", "ch_2", 500, "d1");
  await recordReversal({ ...buyer, test: 1 }, "refund", "ch_test", 999, "r3");
  await logUsage({ userId: "buyer", engine: "image", model: "flux", provider: "fal", credits: 25, costCents: 100, ok: true });
  await addFixedCost({ name: "Vercel Pro", amountCents: 2000, per: "month" });

  const p = await profitReport(since, 30, 200);
  assert.equal(p.plansCents, 2000);
  assert.equal(p.packsCents, 500, "test payments and older ones aren't counted");
  assert.deepEqual([p.planPayments, p.packPayments], [1, 1]);
  assert.equal(p.siteFeesCents, 200 + 20);
  assert.equal(p.siteSales, 2);
  assert.deepEqual(p.otherSiteFees, [{ currency: "CAD", cents: 100, sales: 1 }]);
  assert.equal(p.refundsCents, 500);
  assert.equal(p.refunds, 1);
  assert.equal(p.disputesCents, 500);
  assert.equal(p.disputeFeesCents, DISPUTE_FEE_CENTS);
  assert.equal(p.stripeFeesCents, Math.round(paymentFeeCents(2000, true) + paymentFeeCents(500, false)));
  assert.equal(p.aiCostCents, 100);
  assert.equal(p.fixedCents, fixedCostOver({ amountCents: 2000, per: "month" }, 30));
  assert.equal(p.grossCents, 2000 + 500 + 220 - 500 - 500);
  assert.equal(p.netCents, p.grossCents - p.stripeFeesCents - DISPUTE_FEE_CENTS - 100 - p.fixedCents);
});

test("the dashboard lists every provider, used or not, and counts a request once", async () => {
  await run("DELETE FROM usage");
  await logUsage({
    userId: "buyer",
    engine: "image",
    model: "flux-2-pro",
    provider: "fal",
    credits: 30,
    costCents: 10,
    ok: true,
    parts: [
      { provider: "anthropic", model: "claude-haiku", cents: 1 },
      { provider: "fal", model: "flux-2-pro", cents: 9 },
    ],
  });
  await logUsage({ userId: "buyer", engine: "text", model: "x", provider: "someone-new", credits: 1, costCents: 2, ok: true });
  const body = JSON.parse(JSON.stringify(await adminStats(30)));
  assert.equal(body.requests.total, 2);
  const row = (id: string) => body.byProvider.find((p: { id: string }) => p.id === id);
  for (const p of PROVIDER_LIST) assert.ok(row(p.id), `${p.id} is shown`);
  assert.deepEqual([row("fal").requests, row("fal").costCents], [1, 9]);
  assert.deepEqual([row("anthropic").requests, row("anthropic").costCents], [1, 1]);
  assert.deepEqual([row("groq").requests, row("groq").free, row("groq").setUp], [0, true, true]);
  assert.equal(row("mistral").setUp, false);
  assert.deepEqual(row("mistral").missing, ["MISTRAL_API_KEY"]);
  assert.deepEqual(row("groq").missing, []);
  assert.equal(row("someone-new").provider, "someone-new", "a provider Flash doesn't know still shows");
  assert.equal(JSON.stringify(body).includes(process.env.GROQ_API_KEY!), false, "key values never leave the server");
  assert.ok(body.profit && typeof body.profit.netCents === "number");
});

test("bills the owner types in are checked", async () => {
  for (const c of await fixedCosts()) await removeFixedCost(c.id);
  assert.ok("error" in readFixedCost({ name: "", amount: 20, per: "month" }));
  assert.ok("error" in readFixedCost({ name: "x".repeat(61), amount: 20, per: "month" }));
  assert.ok("error" in readFixedCost({ name: "Vercel", amount: -5, per: "month" }));
  assert.ok("error" in readFixedCost({ name: "Vercel", amount: "abc", per: "month" }));
  assert.ok("error" in readFixedCost({ name: "Vercel", amount: [20], per: "month" }));
  assert.ok("error" in readFixedCost({ name: "Vercel", amount: 2e6, per: "month" }));
  assert.ok("error" in readFixedCost({ name: "Vercel", amount: 20, per: "week" }));
  assert.ok("error" in readFixedCost(null));
  const cost = readFixedCost({ name: "  Vercel   Pro ", amount: "19.999", per: "month" });
  assert.deepEqual(cost, { name: "Vercel Pro", amountCents: 2000, per: "month" });
  assert.equal(await addFixedCost(cost as never), true);
  const list = await fixedCosts();
  assert.deepEqual(list.map((c) => [c.name, c.amountCents, c.per]), [["Vercel Pro", 2000, "month"]]);
  await removeFixedCost(list[0].id);
  assert.deepEqual(await fixedCosts(), []);
});
