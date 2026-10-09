import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in Claude that streams a short answer from whichever model was asked, and keeps what each request sent.
// Models listed in `down` answer with that status instead, like a model Flash's account can't use yet.
const down = new Map<string, number>();
const sent: { model: string; effort?: string; fallbacks?: string; beta: string }[] = [];
const usage = { input_tokens: 1000, output_tokens: 200 };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    sent.push({ model: body.model, effort: body.output_config?.effort, fallbacks: body.fallbacks, beta: String(req.headers["anthropic-beta"] ?? "") });
    const status = down.get(body.model);
    if (status) {
      res.writeHead(status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no" } }));
    }
    const events: object[] = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Hello from ${body.model}` } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { LEVELS, autoLevel, isLevel, levelName } = await import("../src/lib/levels.ts");
const { claudeChoice, defaultChoice, streamText, withStepDown } = await import("../src/lib/engines/claude.ts");
const { CLAUDE_PRICES, MARKUP, claudeCostCents, finalCredits, inputCostCents, planHold } = await import("../src/lib/credits.ts");

type Event = { type: string; delta?: string; message?: string };
const ask = (content: string) => [{ role: "user" as const, content }];
// Runs a reply to the end, keeping nothing.
const drain = async (gen: AsyncGenerator<unknown>) => {
  for await (const event of gen) void event;
};

test("Auto keeps building on Vision, answers quick questions on Sonic, and never picks Ultra on its own", () => {
  const quick = ["hi", "thanks!", "What's the capital of France?", "how many ounces in a cup", "who won the 2022 world cup?"];
  for (const m of quick) assert.equal(autoLevel("text", m).level, "sonic", m);
  const everyday = [
    "write a cover letter for a barista job",
    "Draft an email to my landlord about the broken heater",
    "explain how vaccines work",
    "make my bio sound more professional",
    "x".repeat(200),
  ];
  for (const m of everyday) assert.equal(autoLevel("text", m).level, "ascend", m);
  for (const e of ["app", "slides", "code"] as const) assert.equal(autoLevel(e, "a todo list").level, "vision", e);
  assert.equal(autoLevel("text", "think step by step: is it worth buying a house now?").level, "vision");
  assert.equal(autoLevel("text", "give me a detailed analysis of my sales").level, "vision");
  // Research, translation, documents and files are everyday work, however short.
  for (const e of ["search", "translate", "docs"] as const) assert.equal(autoLevel(e, "hi").level, "ascend", e);
  assert.equal(autoLevel("text", "what is this?", { files: 1 }).level, "ascend");
  // Spoken answers come fastest from Sonic.
  assert.equal(autoLevel("text", "tell me a long story about dragons", { voice: true }).level, "sonic");
  const all = ["hi", "build a shop", "think hard about this", "x".repeat(5000)];
  for (const m of all) for (const e of ["text", "search", "code", "app"] as const) assert.notEqual(autoLevel(e, m).level, "ultra");
  for (const m of [...quick, ...everyday]) assert.ok(autoLevel("text", m).why.includes("Flash "), m);
});

test("each level has a name, and only the five levels are accepted from a request", () => {
  assert.deepEqual(LEVELS.map((l) => l.name), ["Auto", "Flash Sonic", "Flash Ascend", "Flash Vision", "Flash Ultra"]);
  assert.equal(levelName("ultra"), "Flash Ultra");
  for (const ok of ["auto", "sonic", "ascend", "vision", "ultra"]) assert.ok(isLevel(ok));
  for (const bad of ["", "max", "claude-fable-5-1", null, 3, "Sonic"]) assert.ok(!isLevel(bad), String(bad));
});

test("each level runs on its own model, and Ultra steps down to Vision", () => {
  assert.deepEqual(
    (["sonic", "ascend", "vision", "ultra"] as const).map((l) => claudeChoice("text", l).model),
    ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"],
  );
  assert.equal(claudeChoice("text", "sonic").effort, "low");
  assert.equal(claudeChoice("app", "sonic").effort, "low");
  assert.equal(claudeChoice("text", "ascend").effort, "medium");
  assert.equal(claudeChoice("app", "vision").effort, "high");
  assert.equal(claudeChoice("text", "ultra").stepDown?.model, "claude-opus-5-5");
  assert.equal(claudeChoice("text", "vision").stepDown, undefined);
  // Without a level, engines run as they did before levels: Opus for building and code, Sonnet for the rest.
  assert.equal(defaultChoice("app").model, "claude-opus-5-5");
  assert.equal(defaultChoice("code").model, "claude-opus-5-5");
  assert.equal(defaultChoice("text").model, "claude-sonnet-5-5");
  assert.equal(defaultChoice("search").model, "claude-sonnet-5-5");
});

test("Sonic asks Haiku with no refusal fallback, which Haiku doesn't have; the others keep theirs", async () => {
  sent.length = 0;
  const said: string[] = [];
  for await (const e of streamText(ask("hi"), "", "text", undefined, undefined, claudeChoice("text", "sonic"))) said.push((e as Event).delta ?? "");
  assert.equal(said.join(""), "Hello from claude-haiku-5-5");
  assert.deepEqual(sent[0], { model: "claude-haiku-5-5", effort: "low", fallbacks: undefined, beta: "" });
  await drain(streamText(ask("hi"), "", "text", undefined, undefined, claudeChoice("text", "ultra")));
  assert.equal(sent[1].model, "claude-fable-5-1");
  assert.equal(sent[1].fallbacks, "default");
  assert.match(sent[1].beta, /server-side-fallback-2026-07-01/);
  // Called the way it was before levels, it still runs on Sonnet at medium effort.
  await drain(streamText(ask("hi"), "", "text"));
  assert.deepEqual([sent[2].model, sent[2].effort], ["claude-sonnet-5-5", "medium"]);
});

test("when Ultra's model can't take a request, Vision answers it, and only Vision's answer is paid for", async () => {
  for (const status of [404, 403]) {
    down.set("claude-fable-5-1", status);
    sent.length = 0;
    const events: Event[] = [];
    const costs: { model: string; cents: number }[] = [];
    const stepped: string[] = [];
    const choice = claudeChoice("text", "ultra");
    const run = (c: typeof choice) => streamText(ask("prove it"), "", "text", (_p, model, cents) => void costs.push({ model, cents }), undefined, c);
    for await (const e of withStepDown(choice, run, (c) => stepped.push(c.level))) events.push(e as Event);
    assert.deepEqual(sent.map((s) => s.model), ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.equal(events[0].type, "status");
    assert.equal(events[0].message, "Flash Ultra is busy right now, so Flash Vision is answering…");
    assert.equal(events.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Hello from claude-opus-5-5");
    assert.deepEqual(stepped, ["vision"]);
    assert.deepEqual(costs.map((c) => c.model), ["claude-opus-5-5"]);
  }
  down.clear();
});

test("other errors, levels with nowhere to step down to, and errors after words were sent are not retried", async () => {
  const fail = (err: Error, after = "") =>
    async function* () {
      if (after) yield { type: "text" as const, delta: after };
      throw err;
    };
  const notFound = new Anthropic.NotFoundError(404, {}, "no", new Headers());
  const invalid = new Anthropic.BadRequestError(400, {}, "bad", new Headers());
  const status = (n: number) => (err: unknown) => (err as { status?: number }).status === n;
  await assert.rejects(drain(withStepDown(claudeChoice("text", "ultra"), fail(invalid))), status(400));
  await assert.rejects(drain(withStepDown(claudeChoice("text", "vision"), fail(notFound))), status(404));
  await assert.rejects(drain(withStepDown(claudeChoice("text", "ultra"), fail(notFound, "Half an answer"))), status(404));
});

test("Haiku 5.5 is priced by the size of the prompt, and pricier levels hold more without running at a loss", () => {
  assert.equal(claudeCostCents("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 1000 }), 0.06);
  // Over 100,000 tokens of prompt, cached reads included, it costs five times as much.
  assert.equal(claudeCostCents("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 1000 }), 7.75);
  assert.ok(claudeCostCents("claude-haiku-5-5", { input_tokens: 1000, cache_read_input_tokens: 120_000, output_tokens: 0 }) > 0.6);
  assert.equal(claudeCostCents("claude-fable-5-1", { input_tokens: 1000, output_tokens: 1000 }), 6);
  for (const engine of ["text", "search", "code", "app"] as const) {
    for (const model of Object.keys(CLAUDE_PRICES)) {
      for (const inputTokens of [500, 90_000, 150_000]) {
        for (const scale of [0.05, 1, 2.5, 5]) {
          for (const available of [0, 60, 1e6]) {
            const hold = planHold(engine, model, inputTokens, available, scale);
            const price = model === "claude-haiku-5-5" && inputTokens > 100_000 ? CLAUDE_PRICES[model].long! : CLAUDE_PRICES[model];
            const worst = inputCostCents(engine, model, inputTokens) + (hold.maxTokens * price.output) / 1e6;
            assert.ok(worst * MARKUP <= hold.held + 1e-9, `${engine} ${model} ${inputTokens} x${scale}`);
          }
        }
      }
    }
  }
  // Ultra on a chat may hold up to five times the usual allowance, so its answers aren't cut short.
  const usual = planHold("text", "claude-sonnet-5-5", 1000, 1e6);
  const ultra = planHold("text", "claude-fable-5-1", 1000, 1e6, 5);
  assert.ok(ultra.held >= usual.held * 4, `${ultra.held} vs ${usual.held}`);
  assert.ok(ultra.maxTokens >= usual.maxTokens * 0.9);
});

test("a stopped reply is charged at its own model's price", () => {
  const stopped = { held: 200, ok: true, stopped: true, metered: true, costCents: 0, inputCents: 0.01, written: 30_000, typical: 1 };
  const sonic = finalCredits({ ...stopped, outputPrice: 50 });
  const ultra = finalCredits({ ...stopped, outputPrice: 5000 });
  const before = finalCredits(stopped);
  assert.ok(sonic < before && before < ultra, `${sonic} ${before} ${ultra}`);
  // 30,000 characters is about 20,000 tokens with thinking: 1¢ on Haiku, 100¢ on Fable.
  assert.equal(sonic, Math.ceil((0.01 + 1) * MARKUP));
  assert.equal(ultra, 200, "never more than was held");
});
