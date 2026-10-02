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
