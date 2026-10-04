import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_PRICES,
  CREDIT_LIMITS,
  CREDIT_PACKS,
  MARKUP,
  MAX_OUTPUT_TOKENS,
  PLANS,
  REFERRAL_FRIEND_SHARE,
  REFERRAL_REFERRER_CAP,
  REFERRAL_REFERRER_SHARE,
  TYPICAL_CREDITS,
  claudeCostCents,
  creditsFor,
  finalCredits,
  inputCostCents,
  planHold,
  planPrice,
  readCostCents,
  referralBonus,
  transcribeCostCents,
  worstCaseProfitCents,
} from "../src/lib/credits.ts";
import type { Engine } from "../src/lib/types.ts";
import { MODELS, modelCredits } from "../src/lib/models.ts";

test("credits are the provider cost times the markup, rounded up, at least 1", () => {
  assert.equal(creditsFor(0), 1);
  assert.equal(creditsFor(1), Math.ceil(MARKUP));
  assert.equal(creditsFor(240), Math.ceil(240 * MARKUP));
});

test("Claude cost uses the model's token prices", () => {
  // 1M input + 1M output on Sonnet 5.5 = $2 + $10.
  assert.equal(claudeCostCents("claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 1e6 }), 1200);
  // Cache reads cost a tenth, and each web search a cent.
  assert.equal(
    claudeCostCents("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1e6,
      server_tool_use: { web_search_requests: 3 },
    }),
    40 + 3,
  );
  // Unknown models are priced as Opus.
  assert.equal(claudeCostCents("mystery", { input_tokens: 1e6, output_tokens: 0 }), 400);
});

test("every model is priced above what it costs, even at the cheapest plan or pack", () => {
  const cheapestCentsPerCredit = Math.min(
    ...CREDIT_PACKS.map((p) => p.priceCents / p.credits),
    ...PLANS.map((p) => p.yearlyPriceCents / p.credits),
  );
  for (const m of MODELS) {
    const cost = typeof m.costCents === "function" ? m.costCents("a 15 second clip") : m.costCents;
    const revenue = modelCredits(m, "a 15 second clip") * cheapestCentsPerCredit;
    assert.ok(revenue > cost * 1.3, `${m.id}: ${revenue}¢ revenue vs ${cost}¢ cost`);
  }
});

test("Kling is priced by the seconds asked for", () => {
  const kling = MODELS.find((m) => m.id === "kling-3")!;
  assert.ok(modelCredits(kling, "a 15 second clip") > modelCredits(kling, "a 5 second clip"));
});

test("length limits leave room above a typical reply", () => {
  for (const [engine, limit] of Object.entries(CREDIT_LIMITS)) {
    assert.ok(limit! >= (TYPICAL_CREDITS[engine as keyof typeof TYPICAL_CREDITS] ?? 0) * 2, engine);
  }
});

test("every plan and pack makes a profit even if every credit is used", () => {
  for (const p of PLANS) {
    for (const interval of ["month", "year"] as const) {
      const months = interval === "year" ? 12 : 1;
      const price = planPrice(p, interval);
      const profit = worstCaseProfitCents(price, p.credits, true, months);
      assert.ok(profit > (price / months) * 0.2, `${p.id} ${interval}: ${profit}¢ a month`);
      // Still profitable with foreign-card fees (about 2.5% more).
      assert.ok(profit - (price / months) * 0.025 > 0, `${p.id} ${interval} with foreign cards`);
    }
  }
  for (const p of CREDIT_PACKS) {
    assert.ok(worstCaseProfitCents(p.priceCents, p.credits, false) > p.priceCents * 0.2, p.id);
  }
});

test("plans give more credits per dollar than top-ups, and bigger plans give more", () => {
  const bestPack = Math.max(...CREDIT_PACKS.map((p) => p.credits / p.priceCents));
  let last = 0;
  // Team plans are checked against Max below.
  for (const p of PLANS.filter((p) => !p.seats)) {
    const perDollar = p.credits / p.priceCents;
    assert.ok(perDollar > bestPack, p.id);
    assert.ok(perDollar > last, p.id);
    last = perDollar;
  }
});

test("a Claude reply can never cost more than the credits held for it", () => {
  const engines: Engine[] = ["text", "translate", "docs", "search", "code", "app", "slides"];
  for (const engine of engines) {
    for (const model of Object.keys(CLAUDE_PRICES)) {
      for (const inputTokens of [500, 20000, 150000]) {
        for (const available of [0, 50, 100000]) {
          const hold = planHold(engine, model, inputTokens, available);
          assert.ok(hold.held >= hold.needed);
          assert.ok(hold.maxTokens > 0 && hold.maxTokens <= MAX_OUTPUT_TOKENS);
          const worst = inputCostCents(engine, model, inputTokens) + (hold.maxTokens * CLAUDE_PRICES[model].output) / 1e6;
          // Credits held are worth at least cost x MARKUP, and the reply can't spend more than that.
          assert.ok(worst * MARKUP <= hold.held, `${engine} ${model} ${inputTokens}: ${worst}¢ vs ${hold.held} credits`);
          // The cost cap leaves room for a fallback model up to 25% pricier.
          assert.ok(hold.capCents * 1.25 * MARKUP <= hold.held + 1e-9);
        }
      }
    }
  }
});

test("long conversations hold more credits", () => {
  const short = planHold("text", "claude-sonnet-5-5", 1000, 1e6);
  const long = planHold("text", "claude-sonnet-5-5", 150000, 1e6);
  assert.ok(long.held > short.held);
  assert.ok(long.maxTokens >= 1500);
});

test("a stopped reply pays at least for reading its input, never more than was held", () => {
  const inputCents = readCostCents("claude-opus-5-5", 100000); // 40¢ of input
  const base = { held: 400, ok: true, stopped: true, metered: true, costCents: 0, inputCents, written: 0, typical: 4 };
  assert.equal(finalCredits(base), creditsFor(inputCents));
  assert.ok(finalCredits({ ...base, written: 3000 }) > creditsFor(inputCents), "plus what it wrote");
  assert.equal(finalCredits({ ...base, held: 50 }), 50, "capped at the hold");
  assert.equal(finalCredits({ ...base, inputCents: 0 }), 4, "at least a typical reply");
  // A finished reply pays its real cost.
  assert.equal(finalCredits({ ...base, stopped: false, costCents: 10 }), creditsFor(10));
});

test("a failed request pays only for provider work that ran", () => {
  const base = { held: 100, ok: false, stopped: false, metered: false, costCents: 0, inputCents: 5, written: 0, typical: 4 };
  assert.equal(finalCredits(base), 0, "nothing ran: full refund");
  assert.equal(finalCredits({ ...base, costCents: 0.2 }), creditsFor(0.2), "the prompt rewrite ran");
  assert.equal(finalCredits({ ...base, costCents: 1000 }), 100, "never more than held");
  // A Claude reply that broke after writing was billed for its input and output.
  assert.equal(finalCredits({ ...base, metered: true, written: 300 }), creditsFor(5 + (100 * 2 * 2000) / 1e6));
  // Media that finished is charged in full.
  assert.equal(finalCredits({ ...base, ok: true }), 100);
});

test("transcription is priced for the longest recording a file could hold", () => {
  const cheapestCentsPerCredit = Math.min(
    ...CREDIT_PACKS.map((p) => p.priceCents / p.credits),
    ...PLANS.map((p) => p.yearlyPriceCents / p.credits),
  );
  for (const bytes of [1000, 500 * 1024, 3 * 1024 * 1024]) {
    // Worst case: 8 kbps audio at fal.ai's $0.008 a minute (ElevenLabs direct is $0.40 an hour).
    const worstCents = Math.max(1, (bytes / 1000 / 60) * 0.8);
    assert.ok(creditsFor(transcribeCostCents(bytes)) * cheapestCentsPerCredit > worstCents, `${bytes} bytes`);
  }
  assert.ok(transcribeCostCents(3 * 1024 * 1024) > transcribeCostCents(1024 * 1024));
});

/*
 * Business (team) plan and referral bonuses. The worst case for a team plan is the same as for
 * any plan, because members only spend the owner's pool: seats add people, never credits.
 */
const business = PLANS.find((p) => p.id === "business")!;
const max = PLANS.find((p) => p.id === "max")!;
const margin = (price: number, credits: number, months: number) =>
  worstCaseProfitCents(price, credits, true, months) / (price / months);

test("Business is a team plan priced at $99 a month, 20% off yearly", () => {
  assert.equal(business.seats, 5);
  assert.equal(business.priceCents, 9900);
  assert.equal(business.yearlyPriceCents, Math.round(9900 * 0.8));
});

test("Business gives no more credits per dollar than Max, so its worst-case margin is at least Max's", () => {
  assert.ok(business.credits / business.priceCents <= max.credits / max.priceCents);
  assert.ok(business.credits / business.yearlyPriceCents <= max.credits / max.yearlyPriceCents);
  for (const interval of ["month", "year"] as const) {
    const months = interval === "year" ? 12 : 1;
    const b = margin(planPrice(business, interval), business.credits, months);
    const m = margin(planPrice(max, interval), max.credits, months);
    assert.ok(b >= m, `${interval}: Business ${b} vs Max ${m}`);
    // Profitable even if the whole pool is used every month: at least 25% after fees.
    assert.ok(b > 0.25, `${interval}: ${b}`);
  }
});

test("referral bonuses are a share of the credits bought, the referrer's capped", () => {
  assert.deepEqual(referralBonus(500), {
    friend: Math.round(500 * REFERRAL_FRIEND_SHARE),
    referrer: Math.round(500 * REFERRAL_REFERRER_SHARE),
  });
  assert.equal(referralBonus(1_000_000).referrer, REFERRAL_REFERRER_CAP);
});

test("every pack and plan stays profitable with both referral bonuses on its first payment", () => {
  // The first payment earns the bonuses: its credits plus both bonuses, all used. A plan's
  // bonus is on one month's credits; a yearly payment pays for 12 months of credits.
  const firstPayments = [
    ...CREDIT_PACKS.map((p) => ({ id: p.id, price: p.priceCents, credits: p.credits, months: 1, subscription: false })),
    ...PLANS.flatMap((p) =>
      (["month", "year"] as const).map((interval) => ({
        id: `${p.id} ${interval}`,
        price: planPrice(p, interval),
        credits: p.credits,
        months: interval === "year" ? 12 : 1,
        subscription: true,
      })),
    ),
  ];
  for (const f of firstPayments) {
    const bonus = referralBonus(f.credits);
    const profit =
      worstCaseProfitCents(f.price, f.credits * f.months, f.subscription) - (bonus.friend + bonus.referrer) / MARKUP;
    assert.ok(profit > f.price * 0.2, `${f.id}: ${profit}¢ on ${f.price}¢`);
    // Still profitable with foreign-card fees (about 2.5% more).
    assert.ok(profit - f.price * 0.025 > 0, `${f.id} with foreign cards`);
  }
  // The smallest pack spelled out: $5 for 500 credits, +100 for the friend and +100 for the
  // referrer costs Flash at most 280¢, against 455.5¢ left after Stripe's fee.
  const starter = CREDIT_PACKS.find((p) => p.id === "starter")!;
  const bonus = referralBonus(starter.credits);
  assert.deepEqual(bonus, { friend: 100, referrer: 100 });
  assert.ok(starter.priceCents - (starter.priceCents * 0.029 + 30) - (starter.credits + 200) / MARKUP > 0);
});
