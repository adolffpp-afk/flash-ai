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
    // The connection drops after the request was sent: Claude may have run it.
    if (message.startsWith("DROP")) return req.socket.destroy();
    const system = String(body.system ?? "");
    const usage = { input_tokens: Buffer.byteLength(system + message), output_tokens: body.max_tokens };
    if (body.stream) {
      // A model that declines part way, and its refusal fallback answering after a `fallback` block.
      const declines = system.includes("DECLINE");
      const events: object[] = [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1 } } },
        ...(declines
          ? [
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(600) } },
              { type: "content_block_stop", index: 0 },
              { type: "content_block_start", index: 1, content_block: { type: "fallback", from: { model: body.model }, to: { model: "claude-sonnet-5" }, trigger: { type: "refusal" } } },
              { type: "content_block_stop", index: 1 },
            ]
          : []),
        { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Here is an answer." } },
        { type: "content_block_stop", index: 2 },
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
  Running,
  SCENE_WRITER_MAX_CENTS,
  claudeChoice,
  classifyRequest,
  guessEngine,
  improvePrompt,
  pictureRequest,
  streamText,
  writeScenes,
} = await import("../src/lib/engines/claude.ts");
const { CHECK_ALLOWANCE_CENTS, CREDIT_PACKS, MARKUP, PLANS, WRITER_ALLOWANCE_CENTS, claudeCostCents, creditsFor, finalCredits, readCostCents, voiceCredits } =
  await import("../src/lib/credits.ts");
const { MODELS, PACK_WRITING_CENTS, requestCents, modelCredits, writesPrompt } = await import("../src/lib/models.ts");
const { MOVIE_EXTRA_CENTS } = await import("../src/lib/engines/movie.ts");
const { writePack } = await import("../src/lib/engines/post-pack.ts");
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
  assert.deepEqual(sent.map((s) => s.body.max_tokens), [10, 10, 300, 4000]);
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
  // Each stays within the allowance a priced job's price includes for it.
  assert.ok(ROUTER_MAX_CENTS <= CHECK_ALLOWANCE_CENTS && PICTURE_CHECK_MAX_CENTS <= CHECK_ALLOWANCE_CENTS);
  assert.ok(PROMPT_WRITER_MAX_CENTS <= WRITER_ALLOWANCE_CENTS);
  // The scene writer and the router fit in the part of a movie's price set aside for writing and joining.
  assert.ok(SCENE_WRITER_MAX_CENTS + CHECK_ALLOWANCE_CENTS <= MOVIE_EXTRA_CENTS);
});

test("a helper whose connection drops is paid for at its most, since Claude may have run it", async () => {
  const { costs, meter } = metered();
  assert.equal(await classifyRequest("DROP a jingle", meter), null);
  assert.equal(await pictureRequest("DROP make it darker", true, meter), null);
  await assert.rejects(improvePrompt("image", "DROP a cat", meter));
  await assert.rejects(writeScenes("DROP a movie", 3, 10, meter));
  // The post pack's writer too, at the most its writing may cost, which the pack's price includes.
  await assert.rejects(writePack("DROP a social media pack for my bakery", "", meter));
  assert.deepEqual(costs, [ROUTER_MAX_CENTS, PICTURE_CHECK_MAX_CENTS, PROMPT_WRITER_MAX_CENTS, SCENE_WRITER_MAX_CENTS, PACK_WRITING_CENTS]);
});

test("every picture, video, track and voice-over is listed, held and charged at one price that pays for its helpers", () => {
  // The most Flash can spend on a request on this model: the job, the router or the picture check, and the prompt writer.
  const worst = (m: (typeof MODELS)[number], price: number) =>
    price + (m.id === "movie" ? 0 : Math.max(ROUTER_MAX_CENTS, PICTURE_CHECK_MAX_CENTS) + (writesPrompt(m) ? PROMPT_WRITER_MAX_CENTS : 0));
  for (const m of MODELS) {
    for (const request of ["", "a 15 second clip", "a 5 second clip with sound", "a 90 second movie", "a social post pack with a video"]) {
      const price = requestCents(m, request);
      const listed = modelCredits(m, request);
      // A credit always brings in at least 1/MARKUP cents, so the listed price never runs at a loss.
      assert.ok(listed / MARKUP >= worst(m, price), `${m.id} "${request}": ${listed} credits for ${worst(m, price)}¢`);
      assert.ok(listed * cheapestCentsPerCredit > worst(m, price));
      // A finished job is charged exactly what was listed and held, whatever its helpers cost.
      const charged = finalCredits({ held: listed, ok: true, stopped: false, metered: false, costCents: worst(m, price), typical: 4, priced: { credits: listed, helperCents: 0.2, startedCents: price } });
      assert.equal(charged, listed, m.id);
    }
  }
  // The familiar prices stay where the helpers fit in them; where they didn't, the true price is one more.
  const prices = Object.fromEntries(MODELS.map((m) => [m.id, modelCredits(m)]));
  assert.deepEqual(prices, {
    "post-pack": 28,
    "flux-2-pro": 8,
    "gpt-image": 26,
    movie: 1405,
    "remove-bg": 5,
    upscale: 5,
    "flux-2-edit": 18,
    "kling-3-animate": 141,
    "sora-2-pro": 601,
    "veo-3.1": 801,
    "kling-3": 351,
    "eleven-music": 20,
    "minimax-music": 38,
  });
  // A voice-over pays for the router that may have picked it.
  assert.ok(voiceCredits(1000) / MARKUP >= 5 + ROUTER_MAX_CENTS);
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

test("with credits for every engine it may pick, the router picks the engine, and its cost is part of the hold", async () => {
  sent.length = 0;
  const asked: [Engine, number | undefined][] = [];
  const { costs, meter } = metered();
  const routed = await guessEngine("a jingle for my bakery", "text", 1000, planner(asked), everyEngine, meter);
  assert.equal(sent.length, 1);
  assert.deepEqual([routed.engine, routed.guessed], ["music", true]);
  // Checked with the router's worst case before it ran, on the rules' engine and every engine it may pick.
  assert.deepEqual(asked[0], ["text", ROUTER_MAX_CENTS]);
  assert.ok(asked.some(([e, extra]) => e === "video" && extra === ROUTER_MAX_CENTS));
  assert.equal(costs.length, 1);
  assert.ok(costs[0] > 0 && costs[0] <= ROUTER_MAX_CENTS);
  // An engine that isn't set up keeps the rules' engine, with the router paid for in its plan.
  const notReady = await guessEngine("a jingle for my bakery", "text", 1000, planner([]), (e) => e !== "music", meter);
  assert.deepEqual([notReady.engine, notReady.guessed, notReady.plan.needed], ["text", false, 8 + creditsFor(ROUTER_MAX_CENTS)]);
});

test("the router never runs when one of its picks would be too dear, so nobody pays for words they didn't ask for", async () => {
  // 100 credits pay for words and music, not a video: whatever the router said, its pick might not be
  // paid for. So it isn't asked, and the rules' engine answers as it would without it.
  sent.length = 0;
  const asked: [Engine, number | undefined][] = [];
  const { costs, meter } = metered();
  const routed = await guessEngine("a movie about a cat", "text", 100, planner(asked), everyEngine, meter);
  assert.equal(sent.length, 0, "no paid call");
  assert.equal(costs.length, 0);
  assert.deepEqual([routed.engine, routed.guessed, routed.plan.needed], ["text", false, 8]);
  // A picture the user can't afford goes to the free lane or "needs more credits", as a request the
  // rules send there does, never to a paid answer in words.
  assert.ok(!("unpaid" in routed));
  // Engines that aren't set up can't be picked, so they don't stop it.
  const noVideo = await guessEngine("a jingle for my bakery", "text", 100, planner([]), (e) => e !== "video", meter);
  assert.deepEqual([noVideo.engine, noVideo.guessed], ["music", true]);
});

test("a reply stopped after a refusal fallback took over pays for both reads, and stops at once", async () => {
  // Ascend declines after 600 characters; Sonnet 5 reads it all again and starts answering; the user stops.
  const running = new Running();
  const { costs, meter } = metered();
  const said: string[] = [];
  const reply = streamText([{ role: "user", content: "hi" }], "DECLINE", "text", meter, undefined, claudeChoice("text", "ascend"), undefined, { running });
  for await (const e of reply) {
    if (e.type === "text") said.push(e.delta);
    if (said.join("").includes("answer")) break;
  }
  assert.equal(costs.length, 0, "never reported its usage");
  const expected =
    readCostCents("claude-sonnet-5-5", 1000) + (200 * 1000) / 1e6 + readCostCents("claude-sonnet-5", 1200) + ((18 / 3) * 1000) / 1e6;
  assert.ok(Math.abs(running.soFar - expected) < 1e-9, `${running.soFar} vs ${expected}`);
  // Before, only one read and the words were counted.
  assert.ok(running.soFar > readCostCents("claude-sonnet-5-5", 1000) * 2);
  const stopped = finalCredits({ held: 100, ok: true, stopped: true, metered: true, costCents: 0, pendingCents: running.soFar, typical: 4 });
  assert.equal(stopped, Math.max(4, creditsFor(expected)));
  // Finished, the same reply is metered from its usage, and the estimate is spent.
  const done = new Running();
  for await (const e of streamText([{ role: "user", content: "hi" }], "", "text", meter, undefined, claudeChoice("text", "ascend"), undefined, { running: done })) void e;
  assert.equal(costs.length, 1);
  assert.equal(done.soFar, 0);
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
