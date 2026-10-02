import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { addMonths, monthsSince, grantPlanCredits, recordPayment, activeSubscription, endSubscription } = await import(
  "../src/lib/server/subscriptions.ts"
);
const { balance, ensureMonthlyCredits } = await import("../src/lib/server/credits.ts");
const { run } = await import("../src/lib/server/db.ts");

const DAY = 86400000;

test("months are counted from the start date, clamped to short months", () => {
  const jan31 = Date.UTC(2026, 0, 31);
  assert.equal(new Date(addMonths(jan31, 1)).toISOString().slice(0, 10), "2026-02-28");
  assert.equal(new Date(addMonths(jan31, 2)).toISOString().slice(0, 10), "2026-03-31");
  assert.equal(monthsSince(jan31, Date.UTC(2026, 1, 27)), 0);
  assert.equal(monthsSince(jan31, Date.UTC(2026, 1, 28)), 1);
  assert.equal(monthsSince(jan31, Date.UTC(2027, 0, 31)), 12);
});

async function user(id: string) {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', 0)", [id, `${id}@t.io`]);
}

test("a monthly plan adds credits once per paid month, never for unpaid months", async () => {
  await user("u1");
  const start = Date.now() - 2 * DAY;
  await recordPayment({
    subscriptionId: "sub_1", userId: "u1", planId: "pro", interval: "month", customer: "cus_1",
    amountCents: 2500, periodStart: start, periodEnd: addMonths(start, 1), ref: "stripe-invoice:in_1", test: false,
  });
  assert.equal(await balance("u1"), 3000);
  // Webhooks can arrive twice; visiting again in the same month adds nothing.
  await recordPayment({
    subscriptionId: "sub_1", userId: "u1", planId: "pro", interval: "month", customer: "cus_1",
    amountCents: 2500, periodStart: start, periodEnd: addMonths(start, 1), ref: "stripe-invoice:in_1", test: false,
  });
  await ensureMonthlyCredits("u1");
  assert.equal(await balance("u1"), 3000, "subscribers don't also get the free top-up");
  // A month later with no new payment: no credits.
  const sub = (await activeSubscription("u1"))!;
  assert.equal(await grantPlanCredits(sub, addMonths(start, 1) + DAY), false);
  assert.equal(await balance("u1"), 3000);
});

test("a yearly plan adds credits each month of the paid year", async () => {
  await user("u2");
  const start = Date.now() - DAY;
  await recordPayment({
    subscriptionId: "sub_2", userId: "u2", planId: "max", interval: "year", customer: "cus_2",
    amountCents: 192000, periodStart: start, periodEnd: addMonths(start, 12), ref: "stripe-invoice:in_2", test: false,
  });
  const sub = (await activeSubscription("u2"))!;
  for (let m = 1; m < 12; m++) assert.equal(await grantPlanCredits(sub, addMonths(start, m) + DAY), true);
  assert.equal(await grantPlanCredits(sub, addMonths(start, 12) + DAY), false);
  assert.equal(await balance("u2"), 12 * 28000);
});

test("an ended plan stops adding credits but keeps the ones given", async () => {
  await endSubscription("sub_1");
  assert.equal(await activeSubscription("u1"), null);
  assert.equal(await balance("u1"), 3000);
});

const { addPurchase, clawBack, findPurchase } = await import("../src/lib/server/credits.ts");

test("a refunded pack takes back its share of credits, once, never below zero", async () => {
  await user("r1");
  await addPurchase("r1", "starter", "stripe:cs_1", "pi_1");
  const p = (await findPurchase({ paymentIntent: "pi_1" }))!;
  assert.equal(p.credits, 500);
  // Half refunded, then the same webhook again.
  assert.equal(await clawBack(p, 0.5, "ch_1", "stripe-refund:ch_1:250", "Payment refunded"), 250);
  assert.equal(await clawBack(p, 0.5, "ch_1", "stripe-refund:ch_1:250", "Payment refunded"), 0);
  assert.equal(await balance("r1"), 250);
  // The rest refunded later takes only the rest.
  assert.equal(await clawBack(p, 1, "ch_1", "stripe-refund:ch_1:500", "Payment refunded"), 250);
  // A dispute of the same charge takes nothing more.
  assert.equal(await clawBack(p, 1, "ch_1", "stripe-dispute:dp_1:ch_1", "Payment disputed"), 0);
  assert.equal(await balance("r1"), 0);

  // Credits already spent: the balance stops at zero.
  await addPurchase("r1", "starter", "stripe:cs_2", "pi_2");
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('r1', -400, 'spent', 0)");
  const p2 = (await findPurchase({ paymentIntent: "pi_2" }))!;
  assert.equal(await clawBack(p2, 1, "ch_2", "stripe-dispute:dp_2:ch_2", "Payment disputed"), 100);
  assert.equal(await balance("r1"), 0);
});

test("a refunded plan payment is found by its invoice and takes back that month's credits", async () => {
  await user("r2");
  const start = Date.now() - DAY;
  await recordPayment({
    subscriptionId: "sub_r2", userId: "r2", planId: "pro", interval: "month", customer: "cus_r2",
    amountCents: 2500, periodStart: start, periodEnd: addMonths(start, 1), ref: "stripe-invoice:in_r2", test: false,
  });
  const p = (await findPurchase({ paymentIntent: "pi_unknown", ref: "stripe-invoice:in_r2" }))!;
  assert.equal(p.subscription, "sub_r2");
  assert.equal(await clawBack(p, 1, "ch_r2", "stripe-refund:ch_r2:2500", "Payment refunded"), 3000);
  assert.equal(await balance("r2"), 0);
});
