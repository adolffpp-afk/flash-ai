import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for Claude that answers the router with the word set for each latest message.
type Body = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: string; content: string }[];
  thinking?: { type: string };
  output_config?: { effort?: string };
};
const answers: Record<string, string> = {
  "and tomorrow?": "weather",
  "is the Louvre open now": "search",
  "Weather?": " Weather.",
  "what is this": "banana",
  "how are you": "text",
};
const sent: Body[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    sent.push(body);
    const latest = body.messages[0].content.replace(/^[\s\S]*Latest message: /, "");
    const reply = () =>
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          id: "m",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: answers[latest] ?? "text" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 400, output_tokens: 1 },
        }),
      );
    // Slower than the router may wait.
    if (latest === "slow") setTimeout(reply, 500);
    else reply();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { ROUTER_MAX_CENTS, classifyRequest, guessEngine } = await import("../src/lib/engines/claude.ts");
type Engine = import("../src/lib/types.ts").Engine;

test("the router runs on Haiku 5.5 without thinking, at low effort, and writes one word", async () => {
  sent.length = 0;
  await classifyRequest("how are you");
  const [body] = sent;
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.thinking?.type, "disabled");
  assert.equal(body.output_config?.effort, "low");
  assert.equal(body.max_tokens, 10);
  // It knows the forecast, reads any language, and that a short follow-up continues the earlier message.
  assert.match(body.system, /^You route messages in Flash/);
  assert.match(body.system, /\nweather: the weather or forecast for a place/);
  assert.match(body.system, /Messages can be in any language\./);
  assert.match(body.system, /\nsearch: anything else whose answer depends on today: .*opening hours/);
  assert.equal(body.messages[0].content, "Latest message: how are you");
});

test("the router sees the earlier message and the engine of the last reply when they're known", async () => {
  sent.length = 0;
  assert.equal(await classifyRequest("and tomorrow?", undefined, { earlier: "Will it rain in Lagos today?", previous: "text" }), "weather");
  assert.equal(sent[0].messages[0].content, "Earlier message: Will it rain in Lagos today?\nThe previous reply came from: text\nLatest message: and tomorrow?");
  // The earlier message is cut to 300 characters; the latest to 2,000.
  await classifyRequest("x".repeat(2500), undefined, { earlier: "y".repeat(400), previous: "app" });
  const content = sent[1].messages[0].content;
  assert.ok(content.includes(`Earlier message: ${"y".repeat(300)}\n`) && !content.includes("y".repeat(301)));
  assert.ok(content.endsWith(`Latest message: ${"x".repeat(2000)}`));
  assert.match(content, /\nThe previous reply came from: app\n/);
  // Only what's known is sent.
  await classifyRequest("how are you", undefined, { previous: "search" });
  assert.equal(sent[2].messages[0].content, "The previous reply came from: search\nLatest message: how are you");
});

test("in a script that takes more bytes, the router reads less, so a call never costs more than its limit", async () => {
  sent.length = 0;
  await classifyRequest("天".repeat(2000), undefined, { about: "app", offer: `${"€".repeat(300)}?`, earlier: "€".repeat(300), previous: "transcribe" });
  const bytes = Buffer.byteLength(sent[0].system) + Buffer.byteLength(sent[0].messages[0].content);
  assert.ok(bytes <= 5600, `${bytes}`);
  assert.ok(sent[0].messages[0].content.endsWith("天"), "a character is never cut in two");
  assert.ok(ROUTER_MAX_CENTS <= 0.06);
});

test("the router's answer: the forecast, an engine, or nothing when it says something else or takes too long", async () => {
  assert.equal(await classifyRequest("and tomorrow?"), "weather");
  assert.equal(await classifyRequest("Weather?"), "weather");
  assert.equal(await classifyRequest("is the Louvre open now"), "search");
  assert.equal(await classifyRequest("what is this"), null);
  assert.equal(await classifyRequest("slow", undefined, { timeoutMs: 100 }), null);
});

// A planner like the chat route's: Write needs 8 credits, 17 with the forecast; the rest 10.
const planner = (asked: [Engine, number | undefined, boolean | undefined][]) => async (engine: Engine, extraCents?: number, weather?: boolean) => {
  asked.push([engine, extraCents, weather]);
  return { live: true, needed: engine === "text" ? (weather ? 17 : 8) : 10, engine, weather };
};
const everyEngine = () => true;

test("the router's forecast answer is Write with the forecast, paid for like any other answer", async () => {
  sent.length = 0;
  const asked: [Engine, number | undefined, boolean | undefined][] = [];
  const routed = await guessEngine("and tomorrow?", "text", 100, planner(asked), everyEngine, undefined, { weather: true, earlier: "Will it rain today?", previous: "text" });
  assert.deepEqual([routed.engine, routed.guessed, routed.weather, routed.answered, routed.plan.weather], ["text", true, true, true, true]);
  // Checked with the forecast before the router ran, and planned with it after.
  assert.ok(asked.some(([e, extra, weather]) => e === "text" && extra === ROUTER_MAX_CENTS && weather === true));
  assert.deepEqual(asked.at(-1), ["text", undefined, true]);
  assert.match(sent[0].messages[0].content, /^Earlier message: Will it rain today\?/);
});

test("without credits for the forecast the router isn't asked; an answer it can't take still counts as an answer", async () => {
  sent.length = 0;
  // 12 credits pay for Write and the other engines, not Write with the forecast.
  const poor = await guessEngine("and tomorrow?", "text", 12, planner([]), everyEngine, undefined, { weather: true });
  assert.deepEqual([poor.engine, poor.guessed, poor.answered, sent.length], ["text", false, false, 0]);
  // Not offered: the forecast answer isn't taken, but the router did answer.
  const plain = await guessEngine("and tomorrow?", "text", 100, planner([]), everyEngine);
  assert.deepEqual([plain.engine, plain.guessed, plain.weather, plain.answered], ["text", false, undefined, true]);
  // "text" for a request already on Write moves nothing, and is an answer.
  const words = await guessEngine("how are you", "text", 100, planner([]), everyEngine, undefined, { weather: true });
  assert.deepEqual([words.engine, words.guessed, words.answered], ["text", false, true]);
  // No answer in time: none.
  const slow = await guessEngine("slow", "text", 100, planner([]), everyEngine, undefined, { weather: true, timeoutMs: 100 });
  assert.deepEqual([slow.guessed, slow.answered], [false, false]);
});
