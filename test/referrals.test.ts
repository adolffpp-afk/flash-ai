import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { referralCode, referrerFor, rewardReferral, reverseReferral, referralStats } = await import(
  "../src/lib/server/referrals.ts"
);
const { addPurchase, balance, clawBack, findPurchase } = await import("../src/lib/server/credits.ts");
const { addMonths, recordPayment } = await import("../src/lib/server/subscriptions.ts");
const { emailKey } = await import("../src/lib/server/account.ts");
const { run } = await import("../src/lib/server/db.ts");
const { PLANS, REFERRAL_REFERRER_CAP } = await import("../src/lib/credits.ts");

async function user(id: string, email: string, referredBy: string | null = null) {
  await run(
    "INSERT INTO users (id, email, email_key, password_hash, created_at, verified_at, referred_by) VALUES (?, ?, ?, 'x', 0, 1, ?)",
    [id, email, emailKey(email), referredBy],
  );
}

test("referral codes are stable, and an inbox can't refer itself", async () => {
  await user("ref", "ada.lovelace@gmail.com");
  const code = await referralCode("ref");
  assert.equal(await referralCode("ref"), code);
  assert.equal(await referrerFor(code, emailKey("friend@x.io")), "ref");
  // The same Gmail inbox with dots or a +tag is the same person.
  assert.equal(await referrerFor(code, emailKey("Ada.Love.lace+2@gmail.com")), null);
  assert.equal(await referrerFor("nope-nope", emailKey("friend@x.io")), null);
  assert.equal(await referrerFor("<script>", emailKey("friend@x.io")), null);
});

test("signing up earns nothing; only the first real payment gives both bonuses, once", async () => {
  await user("f1", "f1@x.io", "ref");
  // Test purchases (demo mode) never count.
  await addPurchase("f1", "starter", "demo:1");
  assert.equal(await rewardReferral("demo:1"), false);
  assert.equal(await balance("ref"), 0);

  await addPurchase("f1", "starter", "stripe:cs_f1", "pi_f1");
  assert.equal(await rewardReferral("stripe:cs_f1"), true);
  assert.equal(await balance("f1"), 500 + 500 + 100, "test pack, real pack, +20%");
  assert.equal(await balance("ref"), 100);
  // Webhooks can arrive twice.
  assert.equal(await rewardReferral("stripe:cs_f1"), false);
  // A later purchase earns nothing more.
  await addPurchase("f1", "studio", "stripe:cs_f1b", "pi_f1b");
  assert.equal(await rewardReferral("stripe:cs_f1b"), false);
  assert.equal(await balance("ref"), 100);
  assert.deepEqual(await referralStats("ref").then(({ joined, rewarded, earned }) => ({ joined, rewarded, earned })), {
    joined: 1,
    rewarded: 1,
    earned: 100,
  });

  // Users nobody referred earn nothing.
  await user("solo", "solo@x.io");
  await addPurchase("solo", "starter", "stripe:cs_solo", "pi_solo");
  assert.equal(await rewardReferral("stripe:cs_solo"), false);
});

test("a refund or dispute of the rewarded payment takes both bonuses back, in proportion, once", async () => {
  const p = (await findPurchase({ paymentIntent: "pi_f1" }))!;
  // Half refunded: half the pack and half of each bonus.
  await clawBack(p, 0.5, "ch_f1", "stripe-refund:ch_f1:250", "Payment refunded");
  assert.equal(await reverseReferral(p, 0.5, "stripe-refund:ch_f1:250", "Payment refunded"), 50 + 50);
  assert.equal(await reverseReferral(p, 0.5, "stripe-refund:ch_f1:250", "Payment refunded"), 0, "same event twice");
  assert.equal(await balance("ref"), 50);
  // Then disputed in full: only the rest goes.
  await clawBack(p, 1, "ch_f1", "stripe-dispute:dp_f1:ch_f1", "Payment disputed");
  assert.equal(await reverseReferral(p, 1, "stripe-dispute:dp_f1:ch_f1", "Payment disputed"), 50 + 50);
  assert.equal(await balance("ref"), 0);
  assert.equal(await balance("f1"), 500 + 5800, "the test pack and the later studio pack stay");
  assert.equal((await referralStats("ref")).earned, 0);

  // A refund of a payment that earned no bonus takes none.
  const later = (await findPurchase({ paymentIntent: "pi_f1b" }))!;
  assert.equal(await reverseReferral(later, 1, "stripe-refund:ch_f1b:5000", "Payment refunded"), 0);
});

test("the referrer's balance stops at zero when the bonus was already spent", async () => {
  await user("ref2", "ref2@x.io");
  await user("f2", "f2@x.io", "ref2");
  await addPurchase("f2", "studio", "stripe:cs_f2", "pi_f2");
  assert.equal(await rewardReferral("stripe:cs_f2"), true);
  assert.equal(await balance("ref2"), 1160);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('ref2', -1000, 'spent', 0)");
  const p = (await findPurchase({ paymentIntent: "pi_f2" }))!;
  await reverseReferral(p, 1, "stripe-dispute:dp_f2:ch_f2", "Payment disputed");
  assert.equal(await balance("ref2"), 0);
});

test("a plan's first invoice gives bonuses on one month's credits, the referrer's capped", async () => {
  await user("ref3", "ref3@x.io");
  await user("f3", "f3@x.io", "ref3");
  const max = PLANS.find((p) => p.id === "max")!;
  const start = Date.now() - 1000;
  await recordPayment({
    subscriptionId: "sub_f3", userId: "f3", planId: "max", interval: "year", customer: "cus_f3",
    amountCents: max.yearlyPriceCents * 12, periodStart: start, periodEnd: addMonths(start, 12),
    ref: "stripe-invoice:in_f3", test: false,
  });
  assert.equal(await rewardReferral("stripe-invoice:in_f3"), true);
  assert.equal(await balance("f3"), max.credits + Math.round(max.credits * 0.2));
  assert.equal(await balance("ref3"), REFERRAL_REFERRER_CAP);
});
