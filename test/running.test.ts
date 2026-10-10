import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

/*
 * What a Claude call has cost while it streams (Running), for a reply stopped or failed before Claude
 * reports its usage. Each event is fed in as the stream would deliver it.
 */
const { Running, meterClaude } = await import("../src/lib/engines/claude.ts");
const { claudePrice, finalCredits, readCostCents, creditsFor } = await import("../src/lib/credits.ts");

type Event = Anthropic.Beta.BetaRawMessageStreamEvent;
const start = (model: string, usage: Partial<Anthropic.Beta.BetaUsage>): Event =>
  ({ type: "message_start", message: { model, usage: { input_tokens: 0, output_tokens: 1, ...usage } } }) as unknown as Event;
const block = (index: number, content_block: object): Event => ({ type: "content_block_start", index, content_block }) as unknown as Event;
const text = (index: number, t: string): Event => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } }) as Event;
const json = (index: number, partial_json: string): Event => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }) as Event;
const stop = (index: number): Event => ({ type: "content_block_stop", index }) as Event;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("nothing is counted before Claude starts the call, which bills nothing then", () => {
  const running = new Running();
  running.begin("claude-sonnet-5-5", 4000);
  assert.equal(running.soFar, 0);
  // A reply that failed before message_start (overloaded, rate limited) is free.
  assert.equal(finalCredits({ held: 50, ok: false, stopped: false, metered: true, costCents: 0, pendingCents: running.soFar, typical: 4 }), 0);
});

test("the input is counted as Claude reports it, cache reads and writes included, then every character written", () => {
  const running = new Running();
  running.begin("claude-sonnet-5-5", 4000);
  running.see(start("claude-sonnet-5-5", { input_tokens: 10000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000 }));
  const input = ((10000 + 1000 * 1.25 + 50000 * 0.1) * 200) / 1e6;
  assert.ok(close(running.soFar, input));
  // HTML, edit pieces and tool inputs count as much as words: 3 bytes of UTF-8 to a token.
  running.see(block(0, { type: "text", text: "" }));
  running.see(text(0, "x".repeat(3000)));
  running.see(block(1, { type: "server_tool_use", id: "s", name: "web_fetch", input: {} }));
  running.see(json(1, "y".repeat(300)));
  assert.ok(close(running.soFar, input + (1100 * 1000) / 1e6));
  // Chinese is about a token a character, not a third of one.
  running.see(text(0, "字".repeat(100)));
  assert.ok(close(running.soFar, input + (1200 * 1000) / 1e6));
  // Once Claude reports the usage and the call is metered, the estimate is spent.
  running.end();
  assert.equal(running.soFar, 0);
});

test("research counts each search and reading everything again after each result", () => {
  const running = new Running();
  running.begin("claude-sonnet-5-5", 4000);
  running.see(start("claude-sonnet-5-5", { input_tokens: 8000 }));
  running.see(text(0, "a".repeat(300)));
  const result = { type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url: "u", title: "t", encrypted_content: "z".repeat(5997) }] };
  const before = running.soFar;
  running.see(block(2, result));
  const found = Buffer.byteLength(JSON.stringify(result)) / 3;
  assert.ok(close(running.soFar - before, 1 + readCostCents("claude-sonnet-5-5", 8000 + 100 + found)));
  // A search that failed isn't billed, but its result is still read again.
  const failed = { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "unavailable" } };
  const mid = running.soFar;
  running.see(block(3, failed));
  const both = found + Buffer.byteLength(JSON.stringify(failed)) / 3;
  assert.ok(close(running.soFar - mid, readCostCents("claude-sonnet-5-5", 8000 + 100 + both)));
});

test("a refusal fallback is counted from its block: a second read, then the fallback's own price", () => {
  const running = new Running();
  running.begin("claude-fable-5-1", 4000);
  running.see(start("claude-fable-5-1", { input_tokens: 60000 }));
  running.see(text(0, "d".repeat(600)));
  const declined = running.soFar;
  assert.ok(close(declined, readCostCents("claude-fable-5-1", 60000) + (200 * 5000) / 1e6));
  running.see(block(1, { type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } }));
  // Opus 4.8 reads the input and the declined words again, and writes at its own price.
  assert.ok(close(running.soFar, declined + readCostCents("claude-opus-4-8", 60200)));
  running.see(text(2, "o".repeat(300)));
  assert.ok(close(running.soFar, declined + readCostCents("claude-opus-4-8", 60200) + (100 * claudePrice("claude-opus-4-8").output) / 1e6));
  // A model Flash doesn't know is priced as the dearest the request's model can fall back to.
  const unknown = new Running();
  unknown.begin("claude-sonnet-5-5", 4000);
  unknown.see(start("claude-sonnet-5-5", { input_tokens: 1000 }));
  unknown.see(block(0, { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5-20270101" }, trigger: { type: "refusal" } }));
  assert.ok(close(unknown.soFar, readCostCents("claude-sonnet-5-5", 1000) + readCostCents("claude-sonnet-5", 1000)));
});

test("a request Claude routes straight to the fallback model is one read, at that model's price", () => {
  const running = new Running();
  running.begin("claude-fable-5-1", 4000);
  running.see(start("claude-opus-5", { input_tokens: 10000 }));
  assert.ok(close(running.soFar, readCostCents("claude-opus-5", 10000)));
  // A dated or new model name is priced as the model asked for.
  const dated = new Running();
  dated.begin("claude-sonnet-5-5", 4000);
  dated.see(start("claude-sonnet-5-5-20261001", { input_tokens: 10000 }));
  assert.ok(close(dated.soFar, readCostCents("claude-sonnet-5-5", 10000)));
});

test("thinking, which isn't shown, is counted by the time spent on it, never past max_tokens", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const running = new Running();
    running.begin("claude-opus-5-5", 3000);
    running.see(start("claude-opus-5-5", { input_tokens: 1000 }));
    const input = readCostCents("claude-opus-5-5", 1000);
    running.see(block(0, { type: "thinking", thinking: "", signature: "" }));
    mock.timers.tick(5000);
    // 5 seconds at 200 tokens a second, at Opus 5.5's $20 per million.
    assert.ok(close(running.soFar, input + (1000 * 2000) / 1e6));
    mock.timers.tick(60_000);
    assert.ok(close(running.soFar, input + (3000 * 2000) / 1e6), "no more than max_tokens");
    running.see(stop(0));
    mock.timers.tick(60_000);
    assert.ok(close(running.soFar, input + (3000 * 2000) / 1e6), "a finished thinking block stops counting");
    // A stopped reply is charged that, and at least a typical reply.
    assert.equal(finalCredits({ held: 400, ok: true, stopped: true, metered: true, costCents: 0, pendingCents: running.soFar, typical: 4 }), creditsFor(running.soFar));
  } finally {
    mock.timers.reset();
  }
});

test("a declined attempt's searches are paid for, from the results in the reply", () => {
  const costs: number[] = [];
  const message = {
    model: "claude-sonnet-5",
    content: [
      { type: "web_search_tool_result", tool_use_id: "a", content: [] },
      { type: "web_search_tool_result", tool_use_id: "b", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } },
      { type: "text", text: "An answer." },
    ],
    // The usage only counts the attempt that answered, which searched nothing.
    usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 0 } },
  } as unknown as Anthropic.Beta.BetaMessage;
  const running = new Running();
  running.begin("claude-sonnet-5-5", 4000);
  running.see(start("claude-sonnet-5-5", { input_tokens: 1000 }));
  meterClaude((_p, _m, cents) => void costs.push(cents), message, "claude-sonnet-5-5", running);
  // One search returned results (1¢); the one that failed isn't billed.
  assert.deepEqual(costs, [1]);
  assert.equal(running.soFar, 0, "metered, so the estimate is spent");
});
