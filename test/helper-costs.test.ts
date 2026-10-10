import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A stand-in Claude. It keeps what each request sent, and reports the most a call could use: every
 * byte read as a token (no text is ever fewer tokens than that) and the whole max_tokens written.
 * A streamed reply can report a declined attempt and its refusal fallback, as Claude does.
 */
type Body = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { content: string }[];
  stream?: boolean;
  fallbacks?: string;
  thinking?: { type: string };
  output_config?: { effort?: string };
};
const sent: { body: Body; beta: string }[] = [];
const routerAnswers: Record<string, string> = { "a jingle for my bakery": "music", "a movie about a cat": "video" };
let attempts: object[] | null = null;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    sent.push({ body, beta: String(req.headers["anthropic-beta"] ?? "") });
    const message = String(body.messages[0].content);
    const system = String(body.system ?? "");
    const usage = { input_tokens: Buffer.byteLength(system + message), output_tokens: body.max_tokens };
    if (body.stream) {
      const events: object[] = [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here is an answer." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1000, output_tokens: 400, ...(attempts && { iterations: attempts }) } },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
      return res.end();
    }
    const text = system.startsWith("Pick the one tool")
      ? (routerAnswers[message] ?? "text")
      : system.includes("Reply with one word")
        ? "change"
        : system.includes("film director")
          ? '["One", "Two", "Three"]'
          : "A detailed prompt";
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const {
  HELPER_MODEL,
  PICTURE_CHECK_MAX_CENTS,
  PROMPT_WRITER_MAX_CENTS,
  ROUTER_MAX_CENTS,
  SCENE_WRITER_MAX_CENTS,
  claudeChoice,
  classifyRequest,
  guessEngine,
  improvePrompt,
  pictureRequest,
  streamText,
  writeScenes,
} = await import("../src/lib/engines/claude.ts");
const { CREDIT_PACKS, PLANS, claudeCostCents, creditsFor } = await import("../src/lib/credits.ts");
const { MODELS, requestCents, modelCredits } = await import("../src/lib/models.ts");
const { MOVIE_EXTRA_CENTS } = await import("../src/lib/engines/movie.ts");
type Engine = import("../src/lib/types.ts").Engine;

// What a credit is worth at the cheapest plan or pack: Max, billed yearly.
const cheapestCentsPerCredit = Math.min(
  ...CREDIT_PACKS.map((p) => p.priceCents / p.credits),
  ...PLANS.map((p) => p.yearlyPriceCents / p.credits),
);
const metered = () => {
  const costs: number[] = [];
  return { costs, meter: (_p: string, _m: string, cents: number) => void costs.push(cents) };
};
// Three bytes of UTF-8 to a character: the most tokens a text of that length can be.
const longest = "€".repeat(5000);

test("the helpers run on Haiku 5.5 without thinking or a refusal fallback, and write little", async () => {
  sent.length = 0;
  await classifyRequest("a jingle for my bakery");
  await pictureRequest("make it darker", true);
  await improvePrompt("image", "a cat on a sofa", undefined, "Business: Golden Crumb");
  await writeScenes("a movie about a cat", 3, 10);
  assert.equal(sent.length, 4);
  for (const { body, beta } of sent) {
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(HELPER_MODEL, "claude-haiku-5-5");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.output_config?.effort, "low");
    assert.equal(body.fallbacks, undefined, "no second attempt to pay for");
    assert.ok(!/server-side-fallback/.test(beta));
  }
  assert.deepEqual(sent.map((s) => s.body.max_tokens), [10, 10, 500, 4000]);
});

test("each helper costs at most its known worst case, a small part of a cent", async () => {
  const checks: [number, () => Promise<unknown>][] = [
    [ROUTER_MAX_CENTS, () => classifyRequest(longest, meter)],
    [PICTURE_CHECK_MAX_CENTS, () => pictureRequest(longest, true, meter)],
    [PICTURE_CHECK_MAX_CENTS, () => pictureRequest(longest, false, meter)],
    [PROMPT_WRITER_MAX_CENTS, () => improvePrompt("video", longest, meter, longest)],
    [PROMPT_WRITER_MAX_CENTS, () => improvePrompt("music", longest, meter, longest)],
    [SCENE_WRITER_MAX_CENTS, () => writeScenes(longest, 9, 10, meter)],
  ];
  const { costs, meter } = metered();
  for (const [most, call] of checks) {
    await call();
    const cents = costs.at(-1)!;
    assert.ok(cents > 0 && cents <= most, `${cents}¢ vs at most ${most}¢`);
  }
  assert.ok(ROUTER_MAX_CENTS < 0.1 && PICTURE_CHECK_MAX_CENTS < 0.1 && PROMPT_WRITER_MAX_CENTS < 0.2);
  // The scene writer fits in the part of a movie's price set aside for writing and joining.
  assert.ok(SCENE_WRITER_MAX_CENTS <= MOVIE_EXTRA_CENTS);
});

test("every picture, video and track pays for its prompt writer and the router, even at the cheapest credit", () => {
  for (const m of MODELS) {
    const price = requestCents(m, "a 15 second clip");
    // What Flash can spend on one request: the job, the router and, unless the price includes its own writing, the prompt writer.
    const cost = price + ROUTER_MAX_CENTS + (m.edits || m.id === "movie" || m.id === "post-pack" ? PICTURE_CHECK_MAX_CENTS : PROMPT_WRITER_MAX_CENTS);
    const held = creditsFor(cost);
    assert.ok(held * cheapestCentsPerCredit > cost, `${m.id}: ${held} credits for ${cost}¢`);
    // At most one credit more than the listed price.
    assert.ok(creditsFor(price + PROMPT_WRITER_MAX_CENTS + ROUTER_MAX_CENTS) <= modelCredits(m, "a 15 second clip") + 1, m.id);
  }
});

// A planner like the chat route's: each engine needs a fixed number of credits, plus the helpers' worst case.
const NEEDS: Partial<Record<Engine, number>> = { text: 8, music: 20, video: 800 };
const planner = (asked: [Engine, number | undefined][]) => async (engine: Engine, extraCents?: number) => {
  asked.push([engine, extraCents]);
  return { live: true, needed: (NEEDS[engine] ?? 10) + (extraCents ? creditsFor(extraCents) : 0), engine };
};
const everyEngine = () => true;

test("a request that can't be paid for never reaches the router, so the free lane costs Flash nothing", async () => {
  sent.length = 0;
  const asked: [Engine, number | undefined][] = [];
  const { costs, meter } = metered();
  const routed = await guessEngine("a jingle for my bakery", "text", 5, planner(asked), everyEngine, meter);
  assert.equal(sent.length, 0, "no paid call");
  assert.equal(costs.length, 0);
  assert.deepEqual([routed.engine, routed.guessed, routed.plan.needed], ["text", false, 8]);
  // The plan it returns has no router in it.
  assert.deepEqual(asked.at(-1), ["text", undefined]);
});

test("with credits, the router picks the engine, and its cost is part of the hold", async () => {
  sent.length = 0;
  const asked: [Engine, number | undefined][] = [];
  const { costs, meter } = metered();
  const routed = await guessEngine("a jingle for my bakery", "text", 100, planner(asked), everyEngine, meter);
  assert.equal(sent.length, 1);
  assert.deepEqual([routed.engine, routed.guessed], ["music", true]);
  // Checked with the router's worst case before it ran.
  assert.deepEqual(asked[0], ["text", ROUTER_MAX_CENTS]);
  assert.equal(costs.length, 1);
  assert.ok(costs[0] > 0 && costs[0] <= ROUTER_MAX_CENTS);
  // An engine that isn't set up keeps the rules' engine, with the router paid for in its plan.
  const notReady = await guessEngine("a jingle for my bakery", "text", 100, planner([]), (e) => e !== "music", meter);
  assert.deepEqual([notReady.engine, notReady.guessed, notReady.plan.needed], ["text", false, 8 + creditsFor(ROUTER_MAX_CENTS)]);
});

test("a pick the user can't pay for keeps the rules' engine, which the hold already pays the router for", async () => {
  const routed = await guessEngine("a movie about a cat", "text", 100, planner([]), everyEngine);
  assert.deepEqual([routed.engine, routed.guessed, routed.unpaid], ["text", false, { engine: "video", needed: 800 }]);
  assert.equal(routed.plan.needed, 8 + creditsFor(ROUTER_MAX_CENTS));
  assert.ok(routed.plan.needed <= 100);
});

test("a reply a model declined and its fallback answered is metered in full, each attempt at its own price", async () => {
  // Summit declines after 1,000 tokens in and 300 out; Opus 5 reads it all again and answers.
  attempts = [
    { type: "message", model: "claude-fable-5-1", input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    { type: "fallback_message", model: "claude-opus-5", input_tokens: 1300, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ];
  const { costs, meter } = metered();
  for await (const e of streamText([{ role: "user", content: "hi" }], "", "text", meter, undefined, claudeChoice("text", "ultra"))) void e;
  attempts = null;
  const expected = (1000 * 1000 + 300 * 5000) / 1e6 + (1300 * 500 + 400 * 2500) / 1e6;
  assert.equal(costs.length, 1);
  assert.ok(Math.abs(costs[0] - expected) < 1e-9, `${costs[0]} vs ${expected}`);
  // Before, only the usage at the top was priced: 1,000 in and 400 out.
  assert.ok(costs[0] > claudeCostCents("claude-fable-5-1", { input_tokens: 1000, output_tokens: 400 }));
});
