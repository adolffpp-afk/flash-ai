import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDIT_LIMITS, CREDIT_PACKS, MARKUP, TYPICAL_CREDITS, claudeCostCents, creditsFor } from "../src/lib/credits.ts";
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

test("every model is priced above what it costs, even at the cheapest pack", () => {
  const cheapestCentsPerCredit = Math.min(...CREDIT_PACKS.map((p) => p.priceCents / p.credits));
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
