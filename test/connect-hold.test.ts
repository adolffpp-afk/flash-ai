import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECT_STEPS,
  CREDIT_LIMITS,
  MARKUP,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  NO_TOOLS,
  RESEARCH_PLAN,
  WEATHER_PLAN,
  callCost,
  claudePrice,
  connectPlan,
  fallbackModel,
  inputCostCents,
  planHold,
  tokensWithin,
  type ToolPlan,
} from "../src/lib/credits.ts";
import type { Engine } from "../src/lib/types.ts";

/*
 * What a reply with connectors holds (connectPlan in credits.ts): every level, the engines that use
 * them, short and long conversations, and every balance. Run with FLASH_SHOW_HOLDS=1 to print the
 * numbers the pull request quotes.
 */
const SAFETY = 1.25;
const LEVELS: Record<string, string> = { sonic: "claude-haiku-5-5", ascend: "claude-sonnet-5-5", vision: "claude-opus-5-5", ultra: "claude-fable-5-1" };
const ENGINES: Engine[] = ["text", "code", "translate", "docs"];
const INPUTS = [800, 11_000, 60_000, 150_000];
const BALANCES = [0, 5, 40, 300, 5_000, 1_000_000];
// What a level's allowance grows by (see the chat route's scale).
const scaleOf = (engine: Engine, model: string, input: number) =>
  claudePrice(model, input).output / claudePrice(engine === "code" ? "claude-opus-5-5" : "claude-sonnet-5-5", input).output;

function* cases() {
  for (const [level, model] of Object.entries(LEVELS))
    for (const engine of ENGINES)
      for (const input of INPUTS)
        for (const weather of [false, true]) yield { level, model, engine, input, weather, plan: connectPlan(weather), scale: scaleOf(engine, model, input) };
}

test("connectors plan their steps: each re-reads the input, what came back and what the step wrote", () => {
  const plan = connectPlan(false);
  assert.equal(plan.results.length, CONNECT_STEPS - 1);
  assert.equal(plan.oneStep, true);
  assert.deepEqual(connectPlan(true).results, plan.results.map((r) => r + 1500));
});

test("a full hold pays for every step at its worst, and the answer at its allowance", () => {
  for (const c of cases()) {
    const hold = planHold(c.engine, c.model, c.input, 1_000_000, c.scale, 0, c.plan);
    const cost = callCost(c.engine, c.model, c.input, hold.fallback, c.plan);
    const worst = cost.inputCents + (hold.maxTokens * cost.outputPrice) / 1e6;
    assert.ok(worst <= hold.capCents + 1e-9, `${c.level} ${c.engine} ${c.input}: ${worst} > ${hold.capCents}`);
    assert.ok(hold.capCents * MARKUP * SAFETY <= hold.held + 1e-9);
    assert.ok(hold.maxTokens >= (MIN_OUTPUT_TOKENS[c.engine] ?? 1500), `${c.level} ${c.engine} ${c.input}: ${hold.maxTokens}`);
  }
});

test("needing credits for the first step only: never more held than the user has, and never a reply cut below its minimum", () => {
  for (const c of cases()) {
    for (const available of BALANCES) {
      const hold = planHold(c.engine, c.model, c.input, available, c.scale, 0, c.plan);
      assert.ok(hold.held >= hold.needed);
      if (available >= hold.needed) assert.ok(hold.held <= available, `${c.level} ${c.engine}: held ${hold.held} of ${available}`);
      // What is needed pays for the first step: reading the input once and the minimum answer.
      const minOutput = MIN_OUTPUT_TOKENS[c.engine] ?? 1500;
      assert.ok(tokensWithin(c.engine, c.model, c.input, hold.needed / MARKUP / SAFETY, false, NO_TOOLS) >= minOutput);
      if (available >= hold.needed) assert.ok(hold.maxTokens >= minOutput, `${c.level} ${c.engine} ${c.input} at ${available}: ${hold.maxTokens}`);
      // The first step, priced as one call within what is held, is never cut to nothing either.
      assert.ok(Math.min(hold.maxTokens, tokensWithin(c.engine, c.model, c.input, hold.capCents, hold.fallback)) >= minOutput);
    }
  }
});

test("more credits never give a shorter reply", () => {
  for (const c of cases()) {
    let last = 0;
    for (const available of BALANCES) {
      const hold = planHold(c.engine, c.model, c.input, available, c.scale, 0, c.plan);
      if (available < hold.needed) continue;
      assert.ok(hold.maxTokens >= last, `${c.level} ${c.engine} ${c.input} at ${available}`);
      last = hold.maxTokens;
    }
  }
});

// planHold as it was before connectors, for requests without them.
function oldHold(engine: Engine, model: string, inputTokens: number, available: number, scale: number, spentCents: number, plan?: ToolPlan) {
  const p = plan ?? (engine === "search" ? RESEARCH_PLAN : NO_TOOLS);
  const cost = (fallback: boolean) => {
    let inputCents = inputCostCents(engine, model, inputTokens, p);
    let outputPrice = claudePrice(model, inputTokens).output;
    const backup = fallback ? fallbackModel(model) : undefined;
    if (backup) {
      const price = claudePrice(backup, inputTokens);
      inputCents += inputCostCents(engine, backup, inputTokens, p);
      outputPrice += price.output + price.input * (p.results.length + 1);
    }
    return { inputCents, outputPrice };
  };
  const within = (cents: number, fallback: boolean) => {
    const c = cost(fallback);
    return Math.min(MAX_OUTPUT_TOKENS, Math.floor(((cents - c.inputCents) * 1e6) / c.outputPrice));
  };
  const one = cost(false);
  const fixed = one.inputCents + spentCents;
  const needed = Math.ceil((fixed + ((MIN_OUTPUT_TOKENS[engine] ?? 1500) * one.outputPrice) / 1e6) * MARKUP * SAFETY) + 1;
  const limit = Math.ceil(fixed * MARKUP * SAFETY) + Math.ceil((CREDIT_LIMITS[engine] ?? 30) * Math.max(1, scale));
  const held = Math.max(needed, Math.min(limit, available));
  const capCents = held / MARKUP / SAFETY - spentCents;
  const maxTokens = within(capCents, false);
  const alone = { needed, held, maxTokens, capCents, fallback: false, byCredits: held < limit && maxTokens < MAX_OUTPUT_TOKENS };
  if (!fallbackModel(model)) return alone;
  const both = cost(true);
  const heldBoth = Math.ceil((both.inputCents + spentCents + (maxTokens * both.outputPrice) / 1e6) * MARKUP * SAFETY) + 1;
  if (alone.byCredits || available < heldBoth) return alone;
  return { ...alone, held: heldBoth, capCents: heldBoth / MARKUP / SAFETY - spentCents, fallback: true };
}

test("requests without connectors hold exactly what they held before", () => {
  for (const [, model] of Object.entries(LEVELS))
    for (const engine of [...ENGINES, "search"] as Engine[])
      for (const input of INPUTS)
        for (const plan of [undefined, NO_TOOLS, WEATHER_PLAN, RESEARCH_PLAN])
          for (const available of BALANCES)
            for (const spent of [0, 0.3]) {
              const scale = scaleOf(engine, model, input);
              assert.deepEqual(planHold(engine, model, input, available, scale, spent, plan), oldHold(engine, model, input, available, scale, spent, plan));
            }
});

test("the numbers the pull request quotes", () => {
  const rows: string[] = [];
  for (const [level, model] of Object.entries(LEVELS)) {
    const scale = scaleOf("text", model, 11_000);
    const before = planHold("text", model, 11_000, 1_000_000, scale, 0);
    const hold = planHold("text", model, 11_000, 1_000_000, scale, 0, connectPlan(false));
    const least = planHold("text", model, 11_000, 0, scale, 0, connectPlan(false));
    assert.equal(hold.needed, before.needed, "turning connectors on doesn't raise what a reply needs to start");
    rows.push(`${level}: needs ${hold.needed}, holds up to ${hold.held} (without connectors ${before.held}); with only ${least.held} the first step writes up to ${least.maxTokens} tokens`);
  }
  if (process.env.FLASH_SHOW_HOLDS) console.log(rows.join("\n"));
});
