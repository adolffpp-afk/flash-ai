import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_PRICES,
  FALLBACKS,
  claudePrice,
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

// What a credit is worth at the cheapest plan or pack: Max, billed yearly.
const cheapestCentsPerCredit = Math.min(
  ...CREDIT_PACKS.map((p) => p.priceCents / p.credits),
  ...PLANS.map((p) => p.yearlyPriceCents / p.credits),
);

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
  // Unknown models are priced at the dearest rates on the list, so a new model never costs more than it is charged.
  for (const price of Object.values(CLAUDE_PRICES).flatMap((p) => (p.long ? [p, p.long] : [p]))) {
    assert.ok(claudePrice("mystery").input >= price.input && claudePrice("mystery").output >= price.output);
  }
  assert.equal(claudeCostCents("mystery", { input_tokens: 1e6, output_tokens: 1e6 }), 1000 + 5000);
});

test("Anthropic's prices stay as listed, with the fallback models added", () => {
  // In US cents per million tokens of input and output.
  assert.deepEqual(CLAUDE_PRICES["claude-fable-5-1"], { input: 1000, output: 5000 });
  assert.deepEqual(CLAUDE_PRICES["claude-opus-5-5"], { input: 400, output: 2000 });
  assert.deepEqual(CLAUDE_PRICES["claude-sonnet-5-5"], { input: 200, output: 1000 });
  assert.deepEqual(CLAUDE_PRICES["claude-haiku-5-5"], { input: 10, output: 50, long: { over: 100_000, input: 50, output: 250 } });
  assert.deepEqual(CLAUDE_PRICES["claude-haiku-4-5"], { input: 100, output: 500 });
  // Opus 5 and Opus 4.8 cost $5 and $25, more than Opus 5.5.
  assert.deepEqual(CLAUDE_PRICES["claude-opus-5"], { input: 500, output: 2500 });
  assert.deepEqual(CLAUDE_PRICES["claude-opus-4-8"], { input: 500, output: 2500 });
  assert.deepEqual(CLAUDE_PRICES["claude-sonnet-5"], { input: 200, output: 1000 });
  // Every fallback model has a price, and it is the dearest the model can fall back to.
  for (const [model, backup] of Object.entries(FALLBACKS)) {
    assert.ok(Object.hasOwn(CLAUDE_PRICES, model) && Object.hasOwn(CLAUDE_PRICES, backup), model);
  }
  assert.ok(CLAUDE_PRICES["claude-opus-4-8"].output <= CLAUDE_PRICES[FALLBACKS["claude-fable-5-1"]].output);
  // Opus 5.5's fallbacks cost more than it does, so it gets none.
  assert.equal(FALLBACKS["claude-opus-5-5"], undefined);
});

test("a declined attempt and its refusal fallback are both paid for, each at its own model's price", () => {
  // Fable declines after reading 10,000 tokens and writing 2,000; Opus 5 rereads it all and answers.
  // The usage at the top counts only the answer.
  const usage = {
    input_tokens: 12_000,
    output_tokens: 3_000,
    iterations: [
      { model: "claude-fable-5-1", input_tokens: 10_000, output_tokens: 2_000 },
      { model: "claude-opus-5", input_tokens: 12_000, output_tokens: 3_000 },
    ],
  };
  const fable = (10_000 * 1000 + 2_000 * 5000) / 1e6;
  const opus5 = (12_000 * 500 + 3_000 * 2500) / 1e6;
  assert.equal(claudeCostCents("claude-opus-5", usage, "claude-fable-5-1"), fable + opus5);
  // Before, only the answer was priced, and at Opus 5.5's lower rates: 10.8 cents of 33.5.
  assert.ok(claudeCostCents("claude-opus-5", usage) > (12_000 * 400 + 3_000 * 2000) / 1e6 * 3);
  // An attempt that doesn't name its model is priced at the dearer of the model asked for and the one that answered.
  const unnamed = { ...usage, iterations: [{ input_tokens: 10_000, output_tokens: 2_000 }, usage.iterations[1]] };
  assert.equal(claudeCostCents("claude-opus-5", unnamed, "claude-fable-5-1"), fable + opus5);
  // Web searches are counted once, and a call with no attempts listed is priced as before.
  assert.equal(claudeCostCents("claude-opus-5", { ...usage, server_tool_use: { web_search_requests: 2 } }, "claude-fable-5-1"), fable + opus5 + 2);
  assert.equal(claudeCostCents("claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 1e6, iterations: null }), 1200);
  // Never less than the answer alone.
  assert.ok(claudeCostCents("claude-opus-5", { ...usage, iterations: [{ model: "claude-haiku-5-5", input_tokens: 1, output_tokens: 1 }] }) >= opus5);
});

test("every model is priced above what it costs, even at the cheapest plan or pack", () => {
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

/*
 * The most a reply can cost, worked out apart from credits.ts: the model reads the input and writes up
 * to maxTokens; with a refusal fallback, the fallback model then reads the input again with every
 * declined word (at each search step), and writes up to maxTokens of its own.
 */
function worstReplyCents(engine: Engine, model: string, inputTokens: number, maxTokens: number, fallback: boolean): number {
  let cents = inputCostCents(engine, model, inputTokens) + (maxTokens * claudePrice(model, inputTokens).output) / 1e6;
  if (fallback) {
    const backup = FALLBACKS[model];
    const steps = engine === "search" ? 6 : 1;
    cents += inputCostCents(engine, backup, inputTokens);
    cents += (maxTokens * steps * claudePrice(backup, inputTokens).input + maxTokens * claudePrice(backup, inputTokens).output) / 1e6;
  }
  return cents;
}

test("a Claude reply can never cost more than the credits held for it, refusal fallback included", () => {
  const engines: Engine[] = ["text", "translate", "docs", "search", "code", "app", "slides"];
  for (const engine of engines) {
    for (const model of Object.keys(CLAUDE_PRICES)) {
      for (const inputTokens of [500, 20000, 150000]) {
        for (const available of [0, 50, 100000]) {
          for (const spentCents of [0, 0.2]) {
            const hold = planHold(engine, model, inputTokens, available, 1, spentCents);
            assert.ok(hold.held >= hold.needed);
            assert.ok(hold.maxTokens > 0 && hold.maxTokens <= MAX_OUTPUT_TOKENS);
            if (hold.fallback) assert.ok(Object.hasOwn(FALLBACKS, model), `${model} gets no fallback`);
            // The helpers that already ran, and the reply with both attempts at their longest.
            const worst = spentCents + worstReplyCents(engine, model, inputTokens, hold.maxTokens, hold.fallback);
            // Credits held are worth at least cost x MARKUP, and the reply can't spend more than that.
            assert.ok(worst * MARKUP <= hold.held, `${engine} ${model} ${inputTokens}: ${worst}¢ vs ${hold.held} credits`);
            assert.ok(hold.held * cheapestCentsPerCredit >= worst, `${engine} ${model} ${inputTokens} at the cheapest credit`);
            // The cost cap leaves a margin on top.
            assert.ok((hold.capCents + spentCents) * 1.25 * MARKUP <= hold.held + 1e-9);
          }
        }
      }
    }
  }
});

test("a refusal fallback runs only when the credits pay for both attempts at the reply's full length", () => {
  const both = planHold("text", "claude-sonnet-5-5", 1000, 1e6);
  assert.equal(both.fallback, true);
  // Too few credits for both: the reply runs without a fallback, as long as the credits allow.
  const alone = planHold("text", "claude-sonnet-5-5", 1000, both.held - 1);
  assert.equal(alone.fallback, false);
  assert.ok(alone.held < both.held);
  assert.ok(worstReplyCents("text", "claude-sonnet-5-5", 1000, alone.maxTokens, false) * MARKUP <= alone.held);
  // The fallback never shortens a reply: it only runs once the reply alone has all the room it may have.
  assert.equal(both.maxTokens, alone.maxTokens);
  assert.equal(both.needed, alone.needed, "and it never makes a request harder to start");
  // Opus 5.5 and Haiku never get one.
  assert.equal(planHold("text", "claude-opus-5-5", 1000, 1e6).fallback, false);
  assert.equal(planHold("text", "claude-haiku-5-5", 1000, 1e6).fallback, false);
});

test("more credits never give a shorter reply", () => {
  for (const engine of ["text", "docs", "search", "code", "app"] as Engine[]) {
    for (const model of ["claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5-5"]) {
      for (const inputTokens of [500, 4000, 20000, 100000]) {
        let last = 0;
        for (let available = 0; available <= 1500; available++) {
          const hold = planHold(engine, model, inputTokens, available);
          if (available < hold.needed) continue;
          assert.ok(hold.maxTokens >= last, `${engine} ${model} ${inputTokens}: ${hold.maxTokens} at ${available} credits, ${last} below`);
          last = hold.maxTokens;
        }
      }
    }
  }
  // The cases the review found: research on Ascend at 200 credits, text at 37.
  const research = (available: number) => planHold("search", "claude-sonnet-5-5", 3200, available);
  assert.equal(research(200).maxTokens, research(1e6).maxTokens);
  assert.equal(research(200).fallback, false);
  assert.ok(planHold("text", "claude-sonnet-5-5", 20000, 37).maxTokens >= planHold("text", "claude-sonnet-5-5", 20000, 30).maxTokens);
});

test("a reply cut short blames the credits only when they set its length", () => {
  // A user with few credits: the hold is all they have, below the engine's own limit.
  assert.equal(planHold("text", "claude-sonnet-5-5", 1000, 10).byCredits, true);
  // Enough credits: the engine's limit set the length, not the credits.
  assert.equal(planHold("text", "claude-sonnet-5-5", 1000, 1e6).byCredits, false);
  assert.equal(planHold("text", "claude-opus-5-5", 1000, 1e6).byCredits, false);
});

test("long conversations hold more credits", () => {
  const short = planHold("text", "claude-sonnet-5-5", 1000, 1e6);
  const long = planHold("text", "claude-sonnet-5-5", 150000, 1e6);
  assert.ok(long.held > short.held);
  assert.ok(long.maxTokens >= 1500);
});

test("a stopped reply pays for what its call cost so far, at least a typical reply, never more than was held", () => {
  const base = { held: 400, ok: true, stopped: true, metered: true, costCents: 0, pendingCents: 40, typical: 4 };
  assert.equal(finalCredits(base), creditsFor(40));
  // Calls that finished before it (a search round, a builder's first try) are paid in full too.
  assert.equal(finalCredits({ ...base, costCents: 25 }), creditsFor(65));
  assert.equal(finalCredits({ ...base, held: 50 }), 50, "capped at the hold");
  assert.equal(finalCredits({ ...base, pendingCents: 0 }), 4, "at least a typical reply");
  // A finished reply pays its real cost.
  assert.equal(finalCredits({ ...base, stopped: false, costCents: 10 }), creditsFor(10));
  // Without an estimate from the stream (the companion): reading the input, plus what it wrote.
  const inputCents = readCostCents("claude-opus-5-5", 100000); // 40¢ of input
  const old = { held: 400, ok: true, stopped: true, metered: true, costCents: 0, inputCents, written: 0, typical: 4 };
  assert.equal(finalCredits(old), creditsFor(inputCents));
  assert.ok(finalCredits({ ...old, written: 3000 }) > creditsFor(inputCents), "plus what it wrote");
});

test("a failed request pays only for provider work that ran", () => {
  const base = { held: 100, ok: false, stopped: false, metered: false, costCents: 0, pendingCents: 0, typical: 4 };
  assert.equal(finalCredits(base), 0, "nothing ran: full refund");
  assert.equal(finalCredits({ ...base, costCents: 0.2 }), creditsFor(0.2), "the prompt rewrite ran");
  assert.equal(finalCredits({ ...base, costCents: 1000 }), 100, "never more than held");
  // A Claude call that Claude never started (overloaded, rate limited) costs nothing.
  assert.equal(finalCredits({ ...base, metered: true }), 0);
  // One that broke part way was billed for what it read and wrote, words or not.
  assert.equal(finalCredits({ ...base, metered: true, pendingCents: 12 }), creditsFor(12));
  assert.equal(finalCredits({ ...base, metered: true, pendingCents: 12, costCents: 3 }), creditsFor(15));
  // Without an estimate from the stream (the companion): only once it wrote something.
  const old = { held: 100, ok: false, stopped: false, metered: true, costCents: 0, inputCents: 5, written: 0, typical: 4 };
  assert.equal(finalCredits(old), 0);
  assert.equal(finalCredits({ ...old, written: 300 }), creditsFor(5 + (100 * 2 * 2000) / 1e6));
  // Media that finished is charged in full.
  assert.equal(finalCredits({ ...base, ok: true }), 100);
});

test("a priced job pays its listed price; stopped, only for what was really sent", () => {
  // A FLUX.2 Pro picture (3 cents) listed at 8 credits, which pays for its helpers too.
  const held = 8;
  const job = { held, ok: true, stopped: true, metered: false, costCents: 0, typical: 4 };
  const priced = { credits: held, helperCents: 0, startedCents: 0 };
  // Stopped before anything was sent to a provider: nothing at all (it used to be the whole hold).
  assert.equal(finalCredits({ ...job, priced }), 0);
  // Stopped after the prompt writer ran, before the picture was sent: just the writer.
  assert.equal(finalCredits({ ...job, costCents: 0.01, priced: { ...priced, helperCents: 0.01 } }), creditsFor(0.01));
  // Stopped after the picture was sent: the provider bills it whether or not anyone waits for it.
  assert.equal(finalCredits({ ...job, costCents: 0.01, priced: { ...priced, helperCents: 0.01, startedCents: 3 } }), creditsFor(3.01));
  // Stopped after it finished and was metered: counted once.
  assert.equal(finalCredits({ ...job, costCents: 3.01, priced: { ...priced, helperCents: 0.01, startedCents: 3 } }), creditsFor(3.01));
  // A billed job that cost more than its estimate pays what it cost, never more than was held.
  assert.equal(finalCredits({ ...job, costCents: 99, priced: { ...priced, startedCents: 3 } }), held);
  // Finished: its listed price, whatever its helpers cost.
  const done = { ...job, stopped: false };
  assert.equal(finalCredits({ ...done, costCents: 3.05, priced: { ...priced, helperCents: 0.05, startedCents: 3 } }), held);
  assert.equal(finalCredits({ ...done, costCents: 3, priced: { ...priced, startedCents: 3 } }), held);
  // A movie filmed with fewer scenes than priced pays for what was filmed.
  const movie = { credits: creditsFor(422), helperCents: 0.3, startedCents: 420 };
  assert.equal(finalCredits({ ...done, held: creditsFor(562), costCents: 420.3, priced: movie }), creditsFor(422));
  // A job with no price given pays its hold, as before, and the free lane pays nothing.
  assert.equal(finalCredits({ ...done }), held);
  assert.equal(finalCredits({ ...done, held: 0, priced }), 0);
  // A failed job pays only the provider work that ran.
  assert.equal(finalCredits({ ...done, ok: false, costCents: 0.01, priced: { ...priced, helperCents: 0.01 } }), creditsFor(0.01));
});

test("transcription is priced for the longest recording a file could hold", () => {
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
