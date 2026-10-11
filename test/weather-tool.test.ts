import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A stand-in Claude that answers each request with the next scripted reply (content blocks and a stop
 * reason, streamed as Claude streams them, with its usage) or an error status, and keeps every request
 * body. A reply that hangs sends its blocks and never finishes, as a slow answer the user stops.
 */
type Block =
  | { type: "text"; text: string; citations?: object[] }
  | { type: "tool_use" | "server_tool_use"; id: string; name: string; input: object }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "web_search_tool_result"; tool_use_id: string; content: object[] }
  | { type: "fallback"; from: object; to: object };
type Usage = { input_tokens: number; output_tokens: number; server_tool_use?: object };
type Reply = { blocks: Block[]; stop: string; usage?: Usage; hang?: boolean } | { status: number };
const replies: Reply[] = [];
const sent: Record<string, unknown>[] = [];
const standard = { input_tokens: 2000, output_tokens: 100 };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    sent.push(body);
    const reply = replies.shift() ?? { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
    if ("status" in reply) {
      res.writeHead(reply.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted" } }));
    }
    const usage = reply.usage ?? standard;
    const events: object[] = [
      { type: "message_start", message: { id: `msg_${sent.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } },
    ];
    reply.blocks.forEach((b, index) => {
      if (b.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
        for (const citation of b.citations ?? []) events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation } });
      } else if (b.type === "tool_use" || b.type === "server_tool_use") {
        events.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      } else if (b.type === "thinking") {
        events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
        events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
      } else events.push({ type: "content_block_start", index, content_block: b });
      if (!reply.hang) events.push({ type: "content_block_stop", index });
    });
    if (!reply.hang) events.push({ type: "message_delta", delta: { stop_reason: reply.stop }, usage }, { type: "message_stop" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (!reply.hang) res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => {
  server.closeAllConnections();
  server.close();
});

process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { claudeChoice, echoedContent, searchLocation, streamSearch, streamText, withStepDown } = await import("../src/lib/engines/claude.ts");
const { TOO_MANY, WEATHER_TOOL } = await import("../src/lib/weather.ts");
const { planHold, researchPlan } = await import("../src/lib/credits.ts");
const { readEngine } = await import("../src/lib/server/engine-steps.ts");

type Event = { type: string; delta?: string; message?: string; items?: { title: string; url: string }[] };
type Message = { role: string; content: unknown };
const ask = (content: string) => [{ role: "user" as const, content }];
const MET = [
  { title: "Based on data from MET Norway", url: "https://www.met.no/en" },
  { title: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
];
// A forecast tool that answers at once, keeping what it was asked; `empty` places have no data.
function stubTool(empty: string[] = []) {
  const asked: { place?: string; where: string }[] = [];
  return {
    asked,
    tool: {
      status: (input: unknown) => `Checking ${(input as { place?: string }).place ?? "where you are"}…`,
      run: async (input: unknown) => {
        const i = input as { place?: string; where: string };
        asked.push(i);
        return empty.includes(i.place ?? "")
          ? { text: "no data", isError: true, used: false }
          : { text: `Forecast for ${i.place ?? "here"}: 18°C, light rain.`, isError: false, used: true };
      },
      sources: MET,
    },
  };
}
const paris = { where: "named_place", place: "Paris, Île-de-France, France", latitude: 48.86, longitude: 2.35, country: "FR", timezone: "Europe/Paris" };
const run = async (gen: AsyncGenerator<unknown>) => {
  const events: Event[] = [];
  for await (const e of gen) events.push(e as Event);
  return events;
};
const said = (events: Event[]) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");

beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
});

test("a weather question: Claude asks for the forecast, gets it back as it was asked, and answers with MET credited", async () => {
  const { tool, asked } = stubTool();
  const costs: number[] = [];
  let used = 0;
  replies.push(
    {
      blocks: [
        { type: "thinking", thinking: "They want Paris.", signature: "sig-1" },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: paris },
      ],
      stop: "tool_use",
    },
    { blocks: [{ type: "text", text: "In Paris tomorrow: around 18°C with light rain." }], stop: "end_turn" },
  );
  const events = await run(
    streamText(ask("Will it rain in Paris tomorrow?"), "", "text", (_p, _m, cents) => costs.push(cents), undefined, claudeChoice("text", "ascend"), undefined, {}, {
      system: { context: "Today is Saturday 10 October 2026." },
      weather: tool,
      onUsed: () => used++,
    }),
  );
  assert.deepEqual(asked, [paris]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["status", "status", "text", "sources"],
  );
  assert.equal(events[0].message, "Checking Paris, Île-de-France, France…");
  assert.equal(events[1].message, "", "the spinner stops once the forecast is in");
  assert.equal(said(events), "In Paris tomorrow: around 18°C with light rain.");
  assert.deepEqual(events.at(-1)!.items, MET);
  assert.equal(used, 1);
  assert.equal(costs.length, 2, "each call is metered");
  // The second request is the first plus Claude's turn as it was (its thinking kept) and the result.
  const [first, second] = sent as { system: string; tools: unknown; tool_choice: unknown; messages: Message[] }[];
  assert.equal(second.system, first.system, "the same instructions in every call");
  assert.deepEqual(second.tools, first.tools);
  assert.deepEqual(first.tools, [WEATHER_TOOL]);
  assert.ok(!("eager_input_streaming" in (first.tools as object[])[0]));
  assert.deepEqual(first.tool_choice, { type: "auto" });
  assert.match(first.system, /You have a get_weather tool with a live forecast/);
  assert.ok(first.system.endsWith("Today is Saturday 10 October 2026."));
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(second.messages.slice(first.messages.length), [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "They want Paris.", signature: "sig-1" },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: paris },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Forecast for Paris, Île-de-France, France: 18°C, light rain." }] },
  ]);
});

test("parallel calls come back in one message, a reply gets at most three forecasts, and the last round must answer", async () => {
  const { tool, asked } = stubTool(["Nowhere"]);
  let used = 0;
  const call = (id: string, place: string) => ({ type: "tool_use" as const, id, name: "get_weather", input: { ...paris, place } });
  replies.push(
    { blocks: [call("a", "Nowhere"), call("b", "Lyon")], stop: "tool_use" },
    { blocks: [call("c", "Nice"), call("d", "Lille")], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Lyon and Nice: mild." }], stop: "end_turn" },
  );
  const events = await run(
    streamText(ask("weather in four cities"), "", "text", undefined, undefined, claudeChoice("text", "sonic"), undefined, {}, { weather: tool, onUsed: () => used++ }),
  );
  assert.deepEqual(
    asked.map((a) => a.place),
    ["Nowhere", "Lyon", "Nice"],
    "the fourth isn't looked up",
  );
  const second = sent[1] as { messages: Message[]; tool_choice: unknown };
  assert.deepEqual(second.messages.at(-1), {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: "no data", is_error: true },
      { type: "tool_result", tool_use_id: "b", content: "Forecast for Lyon: 18°C, light rain." },
    ],
  });
  const third = sent[2] as { messages: Message[]; tool_choice: unknown };
  assert.deepEqual((third.messages.at(-1)!.content as { content: string }[])[1].content, TOO_MANY);
  assert.deepEqual(second.tool_choice, { type: "auto" });
  assert.deepEqual(third.tool_choice, { type: "none" }, "after two rounds, no more tools");
  assert.equal(used, 1, "the header changes once");
  assert.equal(events.filter((e) => e.type === "status" && e.message === "").length, 2, "each round ends its spinner");
  assert.equal(events.filter((e) => e.type === "sources").length, 1);
});

test("a forecast that never came back credits nobody, and a cut-off or declined turn runs no tool", async () => {
  const empty = stubTool(["Paris, Île-de-France, France"]);
  let used = 0;
  replies.push({ blocks: [{ type: "tool_use", id: "x", name: "get_weather", input: paris }], stop: "tool_use" }, { blocks: [{ type: "text", text: "I couldn't get it." }], stop: "end_turn" });
  const events = await run(streamText(ask("weather in Paris"), "", "text", undefined, undefined, undefined, undefined, {}, { weather: empty.tool, onUsed: () => used++ }));
  assert.equal(used, 0);
  assert.ok(!events.some((e) => e.type === "sources"));
  for (const stop of ["max_tokens", "refusal"]) {
    const { tool, asked } = stubTool();
    replies.push({ blocks: [{ type: "text", text: "Let me check. " }, { type: "tool_use", id: "y", name: "get_weather", input: paris }], stop });
    const out = await run(streamText(ask("weather in Paris"), "", "text", undefined, undefined, undefined, undefined, {}, { weather: tool }));
    assert.deepEqual(asked, [], stop);
    assert.equal(sent.length, 3 + (stop === "refusal" ? 1 : 0), `${stop}: no second call`);
    assert.match(said(out), stop === "refusal" ? /couldn't help/ : /stopped here/);
  }
});

test("after a tool round, the next call only runs when the credits held still pay for it", async () => {
  const { tool } = stubTool();
  const costs: number[] = [];
  replies.push({ blocks: [{ type: "tool_use", id: "z", name: "get_weather", input: paris }], stop: "tool_use" });
  const budget = { maxTokens: 2000, capCents: 1, byCredits: true };
  const events = await run(streamText(ask("weather in Paris"), "", "text", (_p, _m, cents) => costs.push(cents), budget, claudeChoice("text", "ascend"), undefined, {}, { weather: tool }));
  assert.equal(sent.length, 1, "no second call it can't pay for");
  assert.ok(costs.reduce((a, b) => a + b, 0) <= budget.capCents);
  assert.match(said(events), /reached what your credits cover/);
});

test("a call that fails after a paid one isn't started again on another level", async () => {
  const { tool } = stubTool();
  replies.push({ blocks: [{ type: "tool_use", id: "w", name: "get_weather", input: paris }], stop: "tool_use" }, { status: 404 });
  const summit = claudeChoice("text", "ultra");
  const stepped: string[] = [];
  await assert.rejects(
    run(withStepDown(summit, (c) => streamText(ask("weather in Paris"), "", "text", undefined, undefined, c, undefined, {}, { weather: tool }), (c) => stepped.push(c.model))),
    (err: Error) => /part way/.test(err.message),
  );
  assert.equal(stepped.length, 0);
  assert.equal(sent.length, 2);
  // Before anything was paid, the step-down still happens.
  replies.push({ status: 404 }, { blocks: [{ type: "text", text: "hi" }], stop: "end_turn" });
  await run(withStepDown(summit, (c) => streamText(ask("hi"), "", "text", undefined, undefined, c), (c) => stepped.push(c.model)));
  assert.deepEqual(stepped, ["claude-opus-5-5"]);
});

test("without the forecast, Write sends what it always did: no tools", async () => {
  await run(streamText(ask("write a haiku"), "", "text"));
  const body = sent[0] as Record<string, unknown>;
  assert.ok(!("tools" in body) && !("tool_choice" in body));
  assert.doesNotMatch(body.system as string, /get_weather/);
});

test("Research: the user's place, a quick plan, cited links first, one sources list, and forecasts too", async () => {
  const lagos = { timeZone: "Africa/Lagos", city: "Lagos", country: "NG", latitude: 6.45, longitude: 3.4 };
  const result = (url: string, title: string) => ({ type: "web_search_result", url, title, encrypted_content: "e", page_age: null });
  replies.push(
    {
      blocks: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Lagos ferry times" } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [result("https://a.example", "A"), result("https://b.example", "B")] },
      ],
      stop: "pause_turn",
    },
    {
      blocks: [
        {
          type: "text",
          text: "The first ferry leaves at 06:30.",
          citations: [{ type: "web_search_result_location", url: "https://b.example", title: "B", cited_text: "06:30", encrypted_index: "i" }],
        },
      ],
      stop: "end_turn",
    },
  );
  const events = await run(streamSearch(ask("first ferry from Lagos Island today?"), "", undefined, undefined, claudeChoice("search", "ascend"), undefined, {}, { quick: true, where: lagos }));
  const first = sent[0] as { tools: { type: string; max_uses: number; user_location?: object }[]; system: string; messages: Message[] };
  assert.deepEqual(first.tools[0], {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 1,
    user_location: { type: "approximate", city: "Lagos", country: "NG", timezone: "Africa/Lagos" },
  });
  assert.deepEqual([first.tools[1].type, first.tools[1].max_uses], ["web_fetch_20260209", 1]);
  assert.equal(first.tools.length, 2, "no forecast tool when the weather wasn't asked about");
  assert.match(first.system, /This is a research answer[\s\S]*One good search is enough here/);
  assert.equal((sent[1] as { messages: Message[] }).messages.length, first.messages.length + 1, "a paused turn goes back as it was");
  const sources = events.filter((e) => e.type === "sources");
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].items!.map((s) => s.url), ["https://b.example", "https://a.example"], "the cited link first");

  // The weather in Research: a location the tool refuses is dropped once, and MET is credited after the web links.
  const { tool } = stubTool();
  let used = 0;
  const many = Array.from({ length: 9 }, (_, i) => result(`https://w${i}.example`, `W${i}`));
  replies.push(
    { status: 400 },
    {
      blocks: [
        { type: "server_tool_use", id: "srv_2", name: "web_search", input: { query: "Lagos events" } },
        { type: "web_search_tool_result", tool_use_id: "srv_2", content: many },
        { type: "tool_use", id: "toolu_9", name: "get_weather", input: { where: "user_location" } },
      ],
      stop: "tool_use",
    },
    { blocks: [{ type: "text", text: "Dry tonight, so the concert should go ahead." }], stop: "end_turn" },
  );
  sent.length = 0;
  const out = await run(
    streamSearch(ask("is tonight's concert in Lagos likely to be rained off?"), "", undefined, undefined, claudeChoice("search", "ascend"), undefined, {}, {
      where: lagos,
      weather: tool,
      onUsed: () => used++,
    }),
  );
  const [refused, retried, last] = sent as { tools: { type: string; name: string; max_uses?: number; user_location?: object }[]; messages: Message[]; tool_choice?: unknown }[];
  assert.ok(refused.tools[0].user_location);
  assert.equal(retried.tools[0].user_location, undefined);
  assert.deepEqual(retried.tools.map((t) => t.name), ["web_search", "web_fetch", "get_weather"]);
  assert.deepEqual([retried.tools[0].max_uses, retried.tools[1].max_uses], [3, 2], "the full plan");
  assert.deepEqual(last.tools, retried.tools, "the same tools in every call");
  assert.equal(last.tool_choice, undefined);
  assert.equal(used, 1);
  assert.ok(out.some((e) => e.type === "status" && e.message === ""));
  const list = out.filter((e) => e.type === "sources");
  assert.equal(list.length, 1, "one list for the web and the forecast");
  assert.equal(list[0].items!.length, 8);
  assert.deepEqual(list[0].items!.slice(6), MET);
});

test("Summit researches with Fable 5.1's own page reader; the other levels with the usual one", async () => {
  await run(streamSearch(ask("latest news"), "", undefined, undefined, claudeChoice("search", "ultra")));
  await run(streamSearch(ask("latest news"), "", undefined, undefined, claudeChoice("search", "vision")));
  const types = (sent as { tools: { type: string }[] }[]).map((b) => b.tools[1].type);
  assert.deepEqual(types, ["web_fetch_20260318", "web_fetch_20260209"]);
  // No place known, no location sent; UTC alone says nothing.
  assert.equal(searchLocation({ timeZone: "UTC" }), undefined);
  assert.deepEqual(searchLocation({ timeZone: "Europe/Paris" }), { type: "approximate", timezone: "Europe/Paris" });
});

test("Research that searches and then asks for the forecast in one turn still answers, within what was held", async () => {
  const { tool } = stubTool();
  // Ten results of 4 KB, as a normal search brings back; the turn's usage counts the search loop.
  const results = Array.from({ length: 10 }, (_, i) => ({ type: "web_search_result", url: `https://r${i}.example`, title: `R${i}`, encrypted_content: "x".repeat(4000), page_age: null }));
  const read = 2 * 5500 + 50 + 10 * 1383;
  for (const quick of [true, false]) {
    for (const available of quick ? [46, 56, 120, 200, 1000] : [113, 160, 260, 1000]) {
      replies.length = 0;
      sent.length = 0;
      const hold = planHold("search", "claude-sonnet-5-5", 5500, available, 1, 0.05, researchPlan(quick, true));
      assert.ok(hold.held <= available, `${quick} ${available}`);
      replies.push(
        {
          blocks: [
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Lagos concert tonight" } },
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: results },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { where: "user_location" } },
          ],
          stop: "tool_use",
          usage: { input_tokens: read, output_tokens: 150, server_tool_use: { web_search_requests: 1 } },
        },
        { blocks: [{ type: "text", text: "Dry tonight, so the concert should go ahead." }], stop: "end_turn", usage: { input_tokens: read + 1500, output_tokens: 300 } },
      );
      const costs: number[] = [];
      const budget = { maxTokens: hold.maxTokens, capCents: hold.capCents, byCredits: hold.byCredits };
      const events = await run(
        streamSearch(ask("Will tonight's concert in Lagos be rained off?"), "", (_p, _m, cents) => costs.push(cents), budget, { ...claudeChoice("search", "ascend"), fallback: hold.fallback }, undefined, {}, { weather: tool, quick }),
      );
      const label = `${quick ? "quick" : "full"} at ${available} credits`;
      assert.equal(said(events), "Dry tonight, so the concert should go ahead.", label);
      assert.equal(sent.length, 2, label);
      assert.ok(costs.reduce((a, b) => a + b, 0) <= hold.capCents, `${label}: within the cap`);
      // When what is left can't pay for more searches and a full answer, the last call answers with no
      // tools, so more credits never mean a shorter answer.
      const last = sent[1] as { tools: unknown[]; tool_choice?: { type: string }; max_tokens: number };
      assert.ok(last.max_tokens >= 2000, `${label}: room for a full answer (${last.max_tokens})`);
      assert.equal(last.tools.length, 3, `${label}: the tools still go with the turn that used them`);
      if (quick && available === 46) assert.deepEqual(last.tool_choice, { type: "none" }, label);
    }
  }
});

test("a forecast answer stopped part way still credits MET Norway, and Research's links come with it", async () => {
  // Stopped the way the chat route stops a reply (see readEngine): the stream is aborted and drained.
  const stopped = async (start: (signal: AbortSignal) => AsyncGenerator<unknown>) => {
    const abort = new AbortController();
    const out: Event[] = [];
    let wake = () => {};
    let halt = false;
    const gen = start(abort.signal) as AsyncGenerator<never>;
    await assert.rejects(
      readEngine(
        gen,
        (e) => {
          out.push(e as Event);
          if (e.type === "text" && !halt) {
            halt = true;
            abort.abort("stop");
            wake();
          }
        },
        { halted: () => halt, onWake: (w) => (wake = w), drainMs: 2000 },
      ),
    );
    return out;
  };
  const { tool } = stubTool();
  replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: paris }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "In Paris tomorrow: around 18°C with light rain, " }], stop: "end_turn", hang: true },
  );
  const text = await stopped((signal) =>
    streamText(ask("Will it rain in Paris tomorrow?"), "", "text", undefined, undefined, claudeChoice("text", "ascend"), undefined, { signal }, { weather: tool }),
  );
  assert.deepEqual(text.at(-1), { type: "sources", items: MET });

  const result = (url: string, title: string) => ({ type: "web_search_result", url, title, encrypted_content: "e", page_age: null });
  replies.push(
    {
      blocks: [
        { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Paris weekend" } },
        { type: "web_search_tool_result", tool_use_id: "srv_1", content: [result("https://a.example", "A")] },
        { type: "tool_use", id: "toolu_2", name: "get_weather", input: paris },
      ],
      stop: "tool_use",
    },
    { blocks: [{ type: "text", text: "This weekend in Paris: " }], stop: "end_turn", hang: true },
  );
  const research = await stopped((signal) =>
    streamSearch(ask("What's on in Paris this weekend, and will it rain?"), "", undefined, undefined, claudeChoice("search", "ascend"), undefined, { signal }, { weather: tool }),
  );
  assert.deepEqual(research.at(-1)!.items!.map((s) => s.url), ["https://a.example", ...MET.map((s) => s.url)]);
});

test("words before a forecast call end their paragraph, and the answer starts a new one", async () => {
  const { tool } = stubTool();
  replies.push(
    { blocks: [{ type: "text", text: "Let me check the forecast for Paris." }, { type: "tool_use", id: "t1", name: "get_weather", input: paris }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "In Paris tomorrow: " }, { type: "text", text: "around 18°C with light rain." }], stop: "end_turn" },
  );
  const events = await run(streamText(ask("Will it rain in Paris tomorrow?"), "", "text", undefined, undefined, claudeChoice("text", "sonic"), undefined, {}, { weather: tool }));
  assert.equal(said(events), "Let me check the forecast for Paris.\n\nIn Paris tomorrow: around 18°C with light rain.");
  // A call that only asks for the forecast adds no gap.
  replies.push(
    { blocks: [{ type: "tool_use", id: "t2", name: "get_weather", input: paris }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Light rain." }], stop: "end_turn" },
  );
  assert.equal(said(await run(streamText(ask("rain in Paris?"), "", "text", undefined, undefined, claudeChoice("text", "sonic"), undefined, {}, { weather: tool }))), "Light rain.");
});

test("after a refusal fallback part way through, only the answering model's forecast calls run and go back", async () => {
  const { tool, asked } = stubTool();
  const lyon = { ...paris, place: "Lyon" };
  const fallback = { type: "fallback" as const, from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } };
  replies.push(
    {
      blocks: [
        { type: "text", text: "Checking. " },
        { type: "thinking", thinking: "declined reasoning", signature: "sig-declined" },
        { type: "tool_use", id: "t_declined", name: "get_weather", input: paris },
        fallback,
        { type: "tool_use", id: "t_fb", name: "get_weather", input: lyon },
      ],
      stop: "tool_use",
    },
    { blocks: [{ type: "text", text: "Lyon: mild." }], stop: "end_turn" },
  );
  await run(streamText(ask("Will it rain in Lyon tomorrow?"), "", "text", undefined, undefined, claudeChoice("text", "ascend"), undefined, {}, { weather: tool }));
  assert.deepEqual(asked, [lyon], "the declined model's call isn't run");
  const messages = (sent[1] as { messages: Message[] }).messages;
  const echoed = messages.at(-2)!.content as { type: string; id?: string }[];
  assert.deepEqual(
    echoed.map((b) => b.type + (b.id ? `:${b.id}` : "")),
    ["text", "fallback", "tool_use:t_fb"],
  );
  assert.deepEqual(
    (messages.at(-1)!.content as { tool_use_id: string }[]).map((b) => b.tool_use_id),
    ["t_fb"],
  );
  // Research's paired search before the boundary goes back; one with no result doesn't. No fallback, no change.
  const blocks = [
    { type: "server_tool_use", id: "s1", name: "web_search", input: {} },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
    { type: "server_tool_use", id: "s2", name: "web_search", input: {} },
    { type: "redacted_thinking", data: "x" },
    fallback,
    { type: "server_tool_use", id: "s3", name: "web_search", input: {} },
  ] as unknown as Parameters<typeof echoedContent>[0];
  assert.deepEqual(
    echoedContent(blocks).map((b) => ("id" in b ? b.id : b.type)),
    ["s1", "web_search_tool_result", "fallback", "s3"],
  );
  const plain = blocks.filter((b) => b.type !== "fallback");
  assert.equal(echoedContent(plain), plain);
});

test("after a refusal fallback, a search filtered by code goes back with its result, and nothing goes back unpaired", () => {
  const blocks = [
    { type: "thinking", thinking: "declined", signature: "s" },
    { type: "server_tool_use", id: "srv_code", name: "code_execution", input: {} },
    { type: "server_tool_use", id: "srv_ws", name: "web_search", input: {}, caller: { type: "code_execution_20250825", tool_id: "srv_code" } },
    { type: "web_search_tool_result", tool_use_id: "srv_ws", content: [] },
    { type: "code_execution_tool_result", tool_use_id: "srv_code", content: {} },
    { type: "server_tool_use", id: "srv_lost", name: "web_fetch", input: {} },
    { type: "text", text: "Partial." },
    { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } },
    { type: "tool_use", id: "t_fb", name: "get_weather", input: {} },
  ] as unknown as Parameters<typeof echoedContent>[0];
  const echoed = echoedContent(blocks);
  assert.deepEqual(
    echoed.map((b) => b.type + ("id" in b ? `:${b.id}` : "tool_use_id" in b ? `:${b.tool_use_id}` : "")),
    ["server_tool_use:srv_code", "server_tool_use:srv_ws", "web_search_tool_result:srv_ws", "code_execution_tool_result:srv_code", "text", "fallback", "tool_use:t_fb"],
  );
});

test("after a refusal fallback in Research, the next call is budgeted on the search results the declined model found", async () => {
  const { tool } = stubTool();
  const results = Array.from({ length: 10 }, (_, i) => ({ type: "web_search_result", url: `https://f${i}.example`, title: `F${i}`, encrypted_content: "x".repeat(12000), page_age: null }));
  const search: Block[] = [
    { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Lagos" } },
    { type: "web_search_tool_result", tool_use_id: "srv_1", content: results },
  ];
  const fallback: Block = { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } };
  const weather: Block = { type: "tool_use", id: "toolu_1", name: "get_weather", input: { where: "user_location" } };
  const hold = planHold("search", "claude-sonnet-5-5", 5500, 400, 1, 0.05, researchPlan(true, true));
  const budget = { maxTokens: hold.maxTokens, capCents: hold.capCents, byCredits: hold.byCredits };
  // The usage covers only the model that answered (see the API's refusal fallback guidance).
  const room = async (blocks: Block[]) => {
    replies.length = 0;
    sent.length = 0;
    replies.push({ blocks, stop: "tool_use", usage: { input_tokens: 5510, output_tokens: 100 } }, { blocks: [{ type: "text", text: "Dry." }], stop: "end_turn" });
    await run(streamSearch(ask("concert tonight in Lagos?"), "", undefined, budget, { ...claudeChoice("search", "ascend"), fallback: hold.fallback }, undefined, {}, { weather: tool, quick: true }));
    const second = sent[1] as { max_tokens: number; tool_choice?: { type: string } } | undefined;
    return second ? { tokens: second.max_tokens, answerOnly: second.tool_choice?.type === "none" } : { tokens: 0, answerOnly: true };
  };
  // Found before the fallback: the model that answered reads it for the first time on the next call.
  const declinedFound = await room([...search, { type: "text", text: "Partial " }, fallback, weather]);
  // Found by the model that answered, before it asked for the forecast: already in its usage.
  const answeredFound = await room([{ type: "text", text: "Partial " }, fallback, ...search, weather]);
  assert.ok(declinedFound.tokens < answeredFound.tokens || (declinedFound.answerOnly && !answeredFound.answerOnly), JSON.stringify({ declinedFound, answeredFound }));
});
