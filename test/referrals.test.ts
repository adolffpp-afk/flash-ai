import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { referralCode, referrerFor, rewardReferral, reverseReferral, referralStats, releaseReferralBonuses } = await import(
  "../src/lib/server/referrals.ts"
);
const { addPurchase, balance, clawBack, ensureMonthlyCredits, findPurchase } = await import("../src/lib/server/credits.ts");
const { addMonths, recordPayment } = await import("../src/lib/server/subscriptions.ts");
const { emailKey } = await import("../src/lib/server/account.ts");
const { run } = await import("../src/lib/server/db.ts");
const { PLANS, REFERRAL_PENDING_DAYS, REFERRAL_REFERRER_CAP } = await import("../src/lib/credits.ts");

const DAY = 24 * 3600_000;
// Moves a referrer's pending bonuses past their waiting time, as if REFERRAL_PENDING_DAYS went by.
async function waitOut(referrerId: string) {
  await run("UPDATE referral_rewards SET referrer_available_at = referrer_available_at - ? WHERE referrer_id = ?", [
    REFERRAL_PENDING_DAYS * DAY,
    referrerId,
  ]);
  await releaseReferralBonuses(referrerId);
}

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
  assert.equal(await balance("f1"), 500 + 500 + 100, "test pack, real pack, +20% at once");
  // The referrer's bonus is pending until the payment is 30 days old.
  assert.equal(await balance("ref"), 0);
  assert.equal(await releaseReferralBonuses("ref"), 0, "not spendable before 30 days");
  assert.equal(await balance("ref"), 0);
  const stats = await referralStats("ref");
  assert.equal(stats.pending.length, 1);
  assert.equal(stats.pending[0].credits, 100);
  assert.ok(Math.abs(stats.pending[0].availableAt - (Date.now() + REFERRAL_PENDING_DAYS * DAY)) < 60_000);
  assert.equal(stats.earned, 0);
  await waitOut("ref");
  assert.equal(await balance("ref"), 100);
  assert.equal(await releaseReferralBonuses("ref"), 0, "released once");
  assert.equal(await balance("ref"), 100);
  assert.deepEqual((await referralStats("ref")).pending, []);
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
  await waitOut("ref2");
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
  await waitOut("ref3");
  assert.equal(await balance("ref3"), REFERRAL_REFERRER_CAP);
});

test("a refund or dispute while the referrer's bonus is pending cancels it, so it never pays out", async () => {
  for (const [n, event, share] of [
    ["4", "stripe-refund:ch_f4:100", 0.2],
    ["5", "stripe-dispute:dp_f5:ch_f5", 1],
  ] as const) {
    await user(`ref${n}`, `ref${n}@x.io`);
    await user(`f${n}`, `f${n}@x.io`, `ref${n}`);
    await addPurchase(`f${n}`, "starter", `stripe:cs_f${n}`, `pi_f${n}`);
    assert.equal(await rewardReferral(`stripe:cs_f${n}`), true);
    assert.equal((await referralStats(`ref${n}`)).pending.length, 1);
    const p = (await findPurchase({ paymentIntent: `pi_f${n}` }))!;
    await clawBack(p, share, `ch_f${n}`, event, "Payment refunded");
    // Only the friend's bonus is taken back; the referrer's had nothing to take.
    assert.equal(await reverseReferral(p, share, event, "Payment refunded"), Math.round(100 * share));
    assert.deepEqual((await referralStats(`ref${n}`)).pending, []);
    await waitOut(`ref${n}`);
    assert.equal(await balance(`ref${n}`), 0, "a cancelled bonus is never released");
    assert.equal(await releaseReferralBonuses(`ref${n}`, Date.now() + 365 * DAY), 0);
    assert.equal((await referralStats(`ref${n}`)).earned, 0);
  }
});

test("pending bonuses wait their full time, each on its own date", async () => {
  await user("ref6", "ref6@x.io");
  const start = Date.now();
  for (const [n, offset] of [["6a", 0], ["6b", 5 * DAY]] as const) {
    await user(`f${n}`, `f${n}@x.io`, "ref6");
    await addPurchase(`f${n}`, "starter", `stripe:cs_f${n}`, `pi_f${n}`);
    assert.equal(await rewardReferral(`stripe:cs_f${n}`, start + offset), true);
  }
  const due = start + REFERRAL_PENDING_DAYS * DAY;
  assert.equal(await releaseReferralBonuses("ref6", due - 1), 0, "a millisecond early");
  assert.equal(await releaseReferralBonuses("ref6", due), 1);
  assert.equal(await balance("ref6"), 100);
  assert.deepEqual((await referralStats("ref6")).pending, [{ credits: 100, availableAt: due + 5 * DAY }]);
  assert.equal(await releaseReferralBonuses("ref6", due + 5 * DAY), 1);
  assert.equal(await balance("ref6"), 200);
  assert.equal((await referralStats("ref6")).rewarded, 2);
});

test("checking credits (ensureMonthlyCredits) releases due bonuses after the free top-up", async () => {
  await user("ref7", "ref7@x.io");
  await user("f7", "f7@x.io", "ref7");
  await addPurchase("f7", "starter", "stripe:cs_f7", "pi_f7");
  assert.equal(await rewardReferral("stripe:cs_f7", Date.now() - REFERRAL_PENDING_DAYS * DAY - 1), true);
  await ensureMonthlyCredits("ref7");
  assert.equal(await balance("ref7"), 200 + 100, "the full free allowance, then the bonus");
  await ensureMonthlyCredits("ref7");
  assert.equal(await balance("ref7"), 300);
});
