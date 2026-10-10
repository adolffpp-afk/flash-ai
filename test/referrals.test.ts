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
const { CREDIT_PACKS, PLANS, REFERRAL_EARNS, REFERRAL_PENDING_DAYS, REFERRAL_REFERRER_CAP, earnsReferral, planPrice, referralBonus } =
  await import("../src/lib/credits.ts");

const DAY = 24 * 3600_000;
const PRO = PLANS.find((p) => p.id === "pro")!;
// What a Pro subscription earns: 20% of one month's credits each (600 and 600).
const PRO_BONUS = referralBonus(PRO.credits);

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

/** A paid plan period, as invoice.paid records it (test: a demo-mode payment). A renewal reuses sub. */
async function subscribe(
  userId: string,
  planId: string,
  interval: "month" | "year",
  ref: string,
  { sub = `sub_${ref}`, start = Date.now() - 1000, test = false } = {},
) {
  const plan = PLANS.find((p) => p.id === planId)!;
  await recordPayment({
    subscriptionId: sub, userId, planId, interval, customer: `cus_${userId}`, amountCents: planPrice(plan, interval),
    periodStart: start, periodEnd: addMonths(start, interval === "year" ? 12 : 1), ref, test,
  });
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

test("credit packs never earn; the first plan payment gives both bonuses, once, and renewals nothing more", async () => {
  await user("f1", "f1@x.io", "ref");
  // A pack, even the friend's first payment, earns nothing.
  await addPurchase("f1", "starter", "stripe:cs_f1", "pi_f1");
  assert.equal(await rewardReferral("stripe:cs_f1"), false);
  await addPurchase("f1", "studio", "stripe:cs_f1p", "pi_f1p");
  assert.equal(await rewardReferral("stripe:cs_f1p"), false);
  assert.equal(await balance("ref"), 0);
  assert.equal((await referralStats("ref")).pending.length, 0);

  // Then a plan: the packs bought before don't stop it from earning.
  const start = Date.now() - 1000;
  await subscribe("f1", "pro", "month", "stripe-invoice:in_f1", { sub: "sub_f1", start });
  assert.equal(await rewardReferral("stripe-invoice:in_f1"), true);
  assert.equal(await balance("f1"), 500 + 5800 + PRO.credits + PRO_BONUS.friend, "packs, the plan's month, +20% at once");
  // The referrer's bonus is pending until the payment is 30 days old.
  assert.equal(await balance("ref"), 0);
  assert.equal(await releaseReferralBonuses("ref"), 0, "not spendable before 30 days");
  assert.equal(await balance("ref"), 0);
  const stats = await referralStats("ref");
  assert.equal(stats.pending.length, 1);
  assert.equal(stats.pending[0].credits, PRO_BONUS.referrer);
  assert.ok(Math.abs(stats.pending[0].availableAt - (Date.now() + REFERRAL_PENDING_DAYS * DAY)) < 60_000);
  assert.equal(stats.earned, 0);
  await waitOut("ref");
  assert.equal(await balance("ref"), PRO_BONUS.referrer);
  assert.equal(await releaseReferralBonuses("ref"), 0, "released once");
  assert.deepEqual((await referralStats("ref")).pending, []);
  // Webhooks can arrive twice.
  assert.equal(await rewardReferral("stripe-invoice:in_f1"), false);
  // Renewals, a switch to another plan and later packs earn nothing more.
  await subscribe("f1", "pro", "month", "stripe-invoice:in_f1r", { sub: "sub_f1", start: addMonths(start, 1) });
  assert.equal(await rewardReferral("stripe-invoice:in_f1r"), false);
  await subscribe("f1", "max", "year", "stripe-invoice:in_f1m");
  assert.equal(await rewardReferral("stripe-invoice:in_f1m"), false);
  await addPurchase("f1", "creator", "stripe:cs_f1c", "pi_f1c");
  assert.equal(await rewardReferral("stripe:cs_f1c"), false);
  assert.equal(await balance("ref"), PRO_BONUS.referrer);
  assert.deepEqual(await referralStats("ref").then(({ joined, rewarded, earned }) => ({ joined, rewarded, earned })), {
    joined: 1,
    rewarded: 1,
    earned: PRO_BONUS.referrer,
  });

  // Users nobody referred earn nothing.
  await user("solo", "solo@x.io");
  await subscribe("solo", "pro", "month", "stripe-invoice:in_solo");
  assert.equal(await rewardReferral("stripe-invoice:in_solo"), false);
});

test("test payments (demo mode) never earn, and don't use up the reward", async () => {
  await user("ref8", "ref8@x.io");
  await user("f8", "f8@x.io", "ref8");
  await addPurchase("f8", "starter", "demo:1");
  assert.equal(await rewardReferral("demo:1"), false);
  await subscribe("f8", "pro", "month", "demo:plan:f8", { test: true });
  assert.equal(await rewardReferral("demo:plan:f8"), false);
  assert.equal((await referralStats("ref8")).pending.length, 0);
  await subscribe("f8", "pro", "month", "stripe-invoice:in_f8");
  assert.equal(await rewardReferral("stripe-invoice:in_f8"), true);
  assert.equal((await referralStats("ref8")).pending[0].credits, PRO_BONUS.referrer);
});

test("a refund or dispute of the rewarded plan payment takes both bonuses back, in proportion, once", async () => {
  const p = (await findPurchase({ ref: "stripe-invoice:in_f1" }))!;
  const half = { friend: PRO_BONUS.friend / 2, referrer: PRO_BONUS.referrer / 2 };
  // Half refunded: half the plan's credits and half of each bonus.
  await clawBack(p, 0.5, "ch_f1", "stripe-refund:ch_f1:1250", "Payment refunded");
  assert.equal(await reverseReferral(p, 0.5, "stripe-refund:ch_f1:1250", "Payment refunded"), half.friend + half.referrer);
  assert.equal(await reverseReferral(p, 0.5, "stripe-refund:ch_f1:1250", "Payment refunded"), 0, "same event twice");
  assert.equal(await balance("ref"), half.referrer);
  // Then disputed in full: only the rest goes.
  await clawBack(p, 1, "ch_f1", "stripe-dispute:dp_f1:ch_f1", "Payment disputed");
  assert.equal(await reverseReferral(p, 1, "stripe-dispute:dp_f1:ch_f1", "Payment disputed"), half.friend + half.referrer);
  assert.equal(await balance("ref"), 0);
  assert.equal((await referralStats("ref")).earned, 0);

  // A refund of a payment that earned no bonus (a renewal, a pack) takes none.
  for (const ref of ["stripe-invoice:in_f1r", "stripe:cs_f1p"]) {
    const later = (await findPurchase({ ref }))!;
    assert.equal(await reverseReferral(later, 1, `stripe-refund:${ref}`, "Payment refunded"), 0);
  }
});

test("the referrer's balance stops at zero when the bonus was already spent", async () => {
  await user("ref2", "ref2@x.io");
  await user("f2", "f2@x.io", "ref2");
  await subscribe("f2", "pro", "month", "stripe-invoice:in_f2");
  assert.equal(await rewardReferral("stripe-invoice:in_f2"), true);
  await waitOut("ref2");
  assert.equal(await balance("ref2"), PRO_BONUS.referrer);
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES ('ref2', -500, 'spent', 0)");
  const p = (await findPurchase({ ref: "stripe-invoice:in_f2" }))!;
  await reverseReferral(p, 1, "stripe-dispute:dp_f2:ch_f2", "Payment disputed");
  assert.equal(await balance("ref2"), 0);
});

test("a yearly plan's bonuses are on one month's credits, the referrer's capped", async () => {
  await user("ref3", "ref3@x.io");
  await user("f3", "f3@x.io", "ref3");
  const max = PLANS.find((p) => p.id === "max")!;
  await subscribe("f3", "max", "year", "stripe-invoice:in_f3");
  assert.equal(await rewardReferral("stripe-invoice:in_f3"), true);
  assert.equal(await balance("f3"), max.credits + Math.round(max.credits * 0.2));
  await waitOut("ref3");
  assert.equal(await balance("ref3"), REFERRAL_REFERRER_CAP);
});

test("a refund or dispute while the referrer's bonus is pending cancels it, so it never pays out", async () => {
  for (const [n, event, share] of [
    ["4", "stripe-refund:ch_f4:500", 0.2],
    ["5", "stripe-dispute:dp_f5:ch_f5", 1],
  ] as const) {
    await user(`ref${n}`, `ref${n}@x.io`);
    await user(`f${n}`, `f${n}@x.io`, `ref${n}`);
    const start = Date.now() - 1000;
    await subscribe(`f${n}`, "pro", "month", `stripe-invoice:in_f${n}`, { sub: `sub_f${n}`, start });
    assert.equal(await rewardReferral(`stripe-invoice:in_f${n}`), true);
    assert.equal((await referralStats(`ref${n}`)).pending.length, 1);
    const p = (await findPurchase({ ref: `stripe-invoice:in_f${n}` }))!;
    await clawBack(p, share, `ch_f${n}`, event, "Payment refunded");
    // Only the friend's bonus is taken back; the referrer's had nothing to take.
    assert.equal(await reverseReferral(p, share, event, "Payment refunded"), Math.round(PRO_BONUS.friend * share));
    assert.deepEqual((await referralStats(`ref${n}`)).pending, []);
    await waitOut(`ref${n}`);
    assert.equal(await balance(`ref${n}`), 0, "a cancelled bonus is never released");
    assert.equal(await releaseReferralBonuses(`ref${n}`, Date.now() + 365 * DAY), 0);
    assert.equal((await referralStats(`ref${n}`)).earned, 0);
    // A renewal doesn't earn a new bonus in its place.
    if (share < 1) {
      await subscribe(`f${n}`, "pro", "month", `stripe-invoice:in_f${n}r`, { sub: `sub_f${n}`, start: addMonths(start, 1) });
      assert.equal(await rewardReferral(`stripe-invoice:in_f${n}r`), false);
    }
  }
});

test("pending bonuses wait their full time, each on its own date", async () => {
  await user("ref6", "ref6@x.io");
  const start = Date.now();
  for (const [n, offset] of [["6a", 0], ["6b", 5 * DAY]] as const) {
    await user(`f${n}`, `f${n}@x.io`, "ref6");
    await subscribe(`f${n}`, "pro", "month", `stripe-invoice:in_f${n}`);
    assert.equal(await rewardReferral(`stripe-invoice:in_f${n}`, start + offset), true);
  }
  const due = start + REFERRAL_PENDING_DAYS * DAY;
  assert.equal(await releaseReferralBonuses("ref6", due - 1), 0, "a millisecond early");
  assert.equal(await releaseReferralBonuses("ref6", due), 1);
  assert.equal(await balance("ref6"), PRO_BONUS.referrer);
  assert.deepEqual((await referralStats("ref6")).pending, [{ credits: PRO_BONUS.referrer, availableAt: due + 5 * DAY }]);
  assert.equal(await releaseReferralBonuses("ref6", due + 5 * DAY), 1);
  assert.equal(await balance("ref6"), 2 * PRO_BONUS.referrer);
  assert.equal((await referralStats("ref6")).rewarded, 2);
});

test("checking credits (ensureMonthlyCredits) releases due bonuses after the free top-up", async () => {
  await user("ref7", "ref7@x.io");
  await user("f7", "f7@x.io", "ref7");
  await subscribe("f7", "pro", "month", "stripe-invoice:in_f7");
  assert.equal(await rewardReferral("stripe-invoice:in_f7", Date.now() - REFERRAL_PENDING_DAYS * DAY - 1), true);
  await ensureMonthlyCredits("ref7");
  assert.equal(await balance("ref7"), 200 + PRO_BONUS.referrer, "the full free allowance, then the bonus");
  await ensureMonthlyCredits("ref7");
  assert.equal(await balance("ref7"), 200 + PRO_BONUS.referrer);
});

test("REFERRAL_EARNS decides which plans and intervals earn; packs never do", async () => {
  // The default: every paid plan, monthly or yearly.
  for (const plan of PLANS) {
    assert.ok(earnsReferral(`plan:${plan.id}:month`), plan.id);
    assert.ok(earnsReferral(`plan:${plan.id}:year`), plan.id);
  }
  for (const pack of CREDIT_PACKS) assert.equal(earnsReferral(pack.id), false, pack.id);
  assert.equal(earnsReferral("plan:nope:month"), false);
  assert.equal(earnsReferral("plan:pro:week"), false);
  assert.equal(earnsReferral("plan:pro"), false);

  const both = ["month", "year"] as const;
  const earning = (rule: typeof REFERRAL_EARNS) =>
    PLANS.flatMap((p) => both.filter((i) => earnsReferral(`plan:${p.id}:${i}`, rule)).map((i) => `${p.id}:${i}`));
  assert.deepEqual(earning({ plans: ["power", "max"], intervals: both }), ["power:month", "power:year", "max:month", "max:year"]);
  assert.deepEqual(earning({ plans: ["max"], intervals: both }), ["max:month", "max:year"]);
  assert.deepEqual(earning({ plans: PLANS.map((p) => p.id), intervals: ["year"] }), PLANS.map((p) => `${p.id}:year`));

  // rewardReferral follows it. Max only: a Pro payment earns nothing; the first Max one does.
  const saved = { ...REFERRAL_EARNS };
  try {
    REFERRAL_EARNS.plans = ["max"];
    await user("ref9", "ref9@x.io");
    await user("f9", "f9@x.io", "ref9");
    await subscribe("f9", "pro", "month", "stripe-invoice:in_f9");
    assert.equal(await rewardReferral("stripe-invoice:in_f9"), false);
    const start = Date.now() - 1000;
    await subscribe("f9", "max", "month", "stripe-invoice:in_f9m", { sub: "sub_f9m", start });
    assert.equal(await rewardReferral("stripe-invoice:in_f9m"), true);
    await subscribe("f9", "max", "month", "stripe-invoice:in_f9m2", { sub: "sub_f9m", start: addMonths(start, 1) });
    assert.equal(await rewardReferral("stripe-invoice:in_f9m2"), false, "a renewal");
    assert.equal((await referralStats("ref9")).pending[0].credits, REFERRAL_REFERRER_CAP);

    // Yearly only: a monthly plan earns nothing; a yearly one does.
    REFERRAL_EARNS.plans = saved.plans;
    REFERRAL_EARNS.intervals = ["year"];
    await user("ref10", "ref10@x.io");
    await user("f10", "f10@x.io", "ref10");
    await subscribe("f10", "pro", "month", "stripe-invoice:in_f10");
    assert.equal(await rewardReferral("stripe-invoice:in_f10"), false);
    await subscribe("f10", "pro", "year", "stripe-invoice:in_f10y");
    assert.equal(await rewardReferral("stripe-invoice:in_f10y"), true);
  } finally {
    Object.assign(REFERRAL_EARNS, saved);
  }
});
