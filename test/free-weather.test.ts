import { test } from "node:test";
import assert from "node:assert/strict";

// Groq, Gemini, OpenRouter and Mistral are set up; Cloudflare isn't. Every request goes to the stand-ins below.
process.env.GROQ_API_KEY = "g";
process.env.GEMINI_API_KEY = "AQ.test-key";
process.env.OPENROUTER_API_KEY = "or";
process.env.MISTRAL_API_KEY = "m";
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_BASE_URL;
const { streamFreeChat } = await import("../src/lib/engines/free.ts");
type WeatherTool = import("../src/lib/weather.ts").WeatherTool;

type Sent = { host: string; path: string; body: Record<string, unknown> };
const sent: Sent[] = [];
// Providers answering 429, and whether a provider asks for the forecast or answers in words at once.
let busy = new Set<string>();
// Providers whose streamed answer fails after the first call went through.
let failsStreaming = new Set<string>();
// Gemini's first reply holds neither words nor a call, as with its MALFORMED_FUNCTION_CALL.
let geminiEmpty = false;
let asks = true;
// How many forecasts an OpenAI-style provider asks for at once.
let forecastCalls = 1;
const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const PARIS = { where: "named_place", place: "Paris, Île-de-France, France", latitude: 48.85, longitude: 2.35, country: "FR", timezone: "Europe/Paris" };
// What Gemini's first reply holds, which must go back exactly as it came.
const GEMINI_TURN = {
  role: "model",
  parts: [
    { text: "Checking the sky", thought: true },
    { functionCall: { name: "get_weather", args: PARIS, id: "fc-1" }, thoughtSignature: "c2lnbmF0dXJl" },
  ],
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const u = new URL(String(url));
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  sent.push({ host: u.hostname, path: u.pathname, body });
  const provider = u.hostname.split(".").at(-2)!;
  if (busy.has(provider)) return new Response("{}", { status: 429 });
  if (body.stream === true && failsStreaming.has(provider)) return new Response("{}", { status: 500 });
  if (provider === "googleapis") {
    if (u.pathname.endsWith(":generateContent")) {
      if (geminiEmpty) return Response.json({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 0 } });
      const content = asks ? GEMINI_TURN : { role: "model", parts: [{ text: "Il fera beau." }] };
      return Response.json({ candidates: [{ content }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 30, thoughtsTokenCount: 20 } });
    }
    return new Response(
      [
        { candidates: [{ content: { role: "model", parts: [{ text: "Demain à Paris : 18°C" }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: ", sec." }] } }], usageMetadata: { promptTokenCount: 1900, candidatesTokenCount: 12 } },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`)
        .join(""),
    );
  }
  if (body.stream === false) {
    const message = asks
      ? {
          role: "assistant",
          content: null,
          tool_calls: Array.from({ length: forecastCalls }, (_, i) => ({ id: `call_${i + 1}`, type: "function", function: { name: "get_weather", arguments: JSON.stringify(PARIS) } })),
        }
      : { role: "assistant", content: "Sunny, probably." };
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 40 } });
  }
  return new Response(
    sse([
      { choices: [{ delta: { content: "Tomorrow in Paris: 18°C" } }] },
      { choices: [{ delta: { content: ", dry." } }] },
      { choices: [], usage: { prompt_tokens: 2000, completion_tokens: 15 } },
    ]),
  );
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const forecast = (): WeatherTool & { ran: unknown[] } => {
  const ran: unknown[] = [];
  return {
    ran,
    status: (input) => `Checking the forecast for ${(input as { place?: string }).place}…`,
    run: async (input) => (ran.push(input), { text: "Forecast for Paris: tomorrow 18°C, dry.", isError: false, used: true }),
    sources: [{ title: "Based on data from MET Norway", url: "https://www.met.no/en" }],
  };
};

async function ask(message: string, o: { weather?: WeatherTool; country?: string; systemPrompt?: string } = {}) {
  const reserved: { provider: string; count?: number }[] = [];
  const recorded: { provider: string; tokens: number }[] = [];
  const events: { type: string; delta?: string; message?: string; items?: unknown[] }[] = [];
  let usedCalls = 0;
  const reply = streamFreeChat(
    [{ role: "user", content: message }],
    "",
    "text",
    async (provider, _limits, count) => (reserved.push({ provider, count }), true),
    async (provider, tokens) => void recorded.push({ provider, tokens }),
    () => {},
    { country: o.country ?? "US", weather: o.weather, onUsed: () => usedCalls++, systemPrompt: o.systemPrompt },
  );
  for await (const e of reply) events.push(e as (typeof events)[number]);
  const said = events.map((e) => e.delta ?? "").join("");
  return { events, said, reserved, recorded, usedCalls };
}

test("Groq is asked once with the forecast tool, then again with the forecast to answer in words, streamed", async () => {
  sent.length = 0;
  busy = new Set();
  asks = true;
  const tool = forecast();
  const r = await ask("Will it rain in Paris tomorrow?", { weather: tool });
  assert.deepEqual(sent.map((s) => s.host), ["api.groq.com", "api.groq.com"]);
  const [first, second] = sent.map((s) => s.body);
  assert.equal(first.stream, false);
  assert.equal(first.tool_choice, "auto");
  assert.deepEqual((first.tools as { function: { name: string } }[]).map((t) => t.function.name), ["get_weather"]);
  assert.equal(first.stream_options, undefined);
  assert.equal(second.stream, true);
  assert.equal(second.tool_choice, "none");
  assert.deepEqual(second.tools, first.tools);
  const messages = second.messages as { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }[];
  assert.deepEqual(messages.slice(0, -2), first.messages, "the conversation goes again as it was");
  assert.deepEqual(messages.at(-2), {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify(PARIS) } }],
  });
  assert.deepEqual(messages.at(-1), { role: "tool", tool_call_id: "call_1", content: "Forecast for Paris: tomorrow 18°C, dry." });
  assert.match(String(messages[0].content), /get_weather/, "the system prompt has the weather line");
  assert.deepEqual(tool.ran, [PARIS]);
  // The progress line, then it goes; the words; MET Norway's credit at the end.
  assert.deepEqual(
    r.events.map((e) => e.type),
    ["status", "status", "text", "text", "sources"],
  );
  assert.equal(r.events[0].message, "Checking the forecast for Paris, Île-de-France, France…");
  assert.equal(r.events[1].message, "");
  assert.equal(r.said, "Tomorrow in Paris: 18°C, dry.");
  assert.equal(r.usedCalls, 1);
  // Both calls are reserved at once, and both are recorded.
  assert.deepEqual(r.reserved, [{ provider: "groq", count: 2 }]);
  assert.deepEqual(r.recorded, [{ provider: "groq", tokens: 900 + 40 + 2000 + 15 }]);
});

test("a reply in words at once is the answer, with no forecast and no credit", async () => {
  sent.length = 0;
  asks = false;
  const r = await ask("Will it rain in Paris tomorrow?", { weather: forecast() });
  asks = true;
  assert.equal(sent.length, 1);
  assert.equal(r.said, "Sunny, probably.");
  assert.deepEqual(r.events.map((e) => e.type), ["text"]);
  assert.equal(r.usedCalls, 0);
  assert.deepEqual(r.recorded, [{ provider: "groq", tokens: 940 }]);
});

test("Gemini gets its own shapes: the first call whole, its turn echoed with the thought signature, then streamed", async () => {
  sent.length = 0;
  const r = await ask("Va-t-il pleuvoir demain à Paris ?", { weather: forecast() });
  // Not in English, from the US: Gemini is asked first, ahead of Groq.
  assert.deepEqual(sent.map((s) => s.host), ["generativelanguage.googleapis.com", "generativelanguage.googleapis.com"]);
  assert.deepEqual(sent.map((s) => s.path.split(":").at(-1)), ["generateContent", "streamGenerateContent"]);
  const [first, second] = sent.map((s) => s.body);
  assert.deepEqual(first.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  assert.deepEqual((first.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations.map((f) => f.name), ["get_weather"]);
  assert.deepEqual(second.toolConfig, { functionCallingConfig: { mode: "NONE" } });
  const contents = second.contents as object[];
  assert.deepEqual(contents.at(-2), GEMINI_TURN, "the model's turn goes back exactly as it came");
  assert.deepEqual(contents.at(-1), {
    role: "user",
    parts: [{ functionResponse: { name: "get_weather", id: "fc-1", response: { content: "Forecast for Paris: tomorrow 18°C, dry." } } }],
  });
  assert.equal(r.said, "Demain à Paris : 18°C, sec.");
  assert.deepEqual(r.reserved, [{ provider: "gemini", count: 2 }]);
  // Thinking is counted with the words.
  assert.deepEqual(r.recorded, [{ provider: "gemini", tokens: 800 + 50 + 1900 + 12 }]);
});

test("for the forecast, providers with tools come first; one without is told it can't check the weather", async () => {
  sent.length = 0;
  busy = new Set(["groq", "mistral"]);
  // Gemini may not answer in France, so Mistral would be next, then OpenRouter, which has no tools.
  const r = await ask("Will it rain in Paris tomorrow?", { weather: forecast(), country: "FR" });
  busy = new Set();
  assert.deepEqual(sent.map((s) => s.host), ["api.groq.com", "api.mistral.ai", "openrouter.ai"]);
  assert.deepEqual(r.reserved, [
    { provider: "groq", count: 2 },
    { provider: "mistral", count: 2 },
    { provider: "openrouter", count: 1 },
  ]);
  const body = sent[2].body;
  assert.equal(body.tools, undefined);
  assert.equal(body.stream, true);
  const instructions = String((body.messages as { content: string }[])[0].content);
  assert.match(instructions, /can't search the web\. For anything that changes \(the weather, news/);
  assert.doesNotMatch(instructions, /get_weather/);
  assert.equal(r.said, "Tomorrow in Paris: 18°C, dry.");
  assert.equal(r.usedCalls, 0);
  assert.ok(!r.events.some((e) => e.type === "sources"));
});

test("Mistral's tool message names the function, as its API asks", async () => {
  sent.length = 0;
  busy = new Set(["groq"]);
  await ask("Will it rain in Paris tomorrow?", { weather: forecast(), country: "FR" });
  busy = new Set();
  assert.deepEqual(sent.map((s) => s.host), ["api.groq.com", "api.mistral.ai", "api.mistral.ai"]);
  const messages = sent[2].body.messages as { role: string; name?: string }[];
  assert.deepEqual(messages.at(-1), { role: "tool", tool_call_id: "call_1", content: "Forecast for Paris: tomorrow 18°C, dry.", name: "get_weather" });
});

test("when the answer after a forecast fails, the backup that answers without one isn't credited with it", async () => {
  sent.length = 0;
  busy = new Set(["mistral"]);
  failsStreaming = new Set(["groq"]);
  const tool = forecast();
  const r = await ask("Will it rain in Paris tomorrow?", { weather: tool, country: "FR" });
  busy = new Set();
  failsStreaming = new Set();
  assert.deepEqual(sent.map((s) => s.host), ["api.groq.com", "api.groq.com", "api.mistral.ai", "openrouter.ai"]);
  assert.equal(tool.ran.length, 1, "Groq's forecast was fetched");
  assert.equal(r.said, "Tomorrow in Paris: 18°C, dry.");
  // OpenRouter answered without it: the header isn't changed and MET isn't credited.
  assert.equal(r.usedCalls, 0);
  assert.ok(!r.events.some((e) => e.type === "sources"));
  // Groq's first call still counts toward its daily tokens.
  assert.deepEqual(r.recorded, [{ provider: "groq", tokens: 940 }, { provider: "openrouter", tokens: 2015 }]);
});

test("a reply's three forecasts are its whole allowance: the provider that takes over after Groq's answer fails gets no forecast tool", async () => {
  sent.length = 0;
  failsStreaming = new Set(["groq"]);
  forecastCalls = 3;
  const tool = forecast();
  const r = await ask("Will it rain in Paris, Lyon and Nice tomorrow?", { weather: tool, country: "FR" });
  failsStreaming = new Set();
  forecastCalls = 1;
  assert.deepEqual(sent.map((s) => s.host), ["api.groq.com", "api.groq.com", "api.mistral.ai"]);
  assert.equal(tool.ran.length, 3, "Groq's three forecasts, and none after");
  assert.deepEqual(r.reserved.at(-1), { provider: "mistral", count: 1 });
  const mistral = sent[2].body;
  assert.deepEqual([mistral.tools, mistral.stream], [undefined, true]);
  assert.doesNotMatch(String((mistral.messages as { content: string }[])[0].content), /get_weather/);
  assert.equal(r.usedCalls, 0);
  assert.ok(!r.events.some((e) => e.type === "sources"));
});

test("an empty first reply isn't the answer: the next provider answers, and the empty call still counts", async () => {
  sent.length = 0;
  geminiEmpty = true;
  const r = await ask("Va-t-il pleuvoir demain à Paris ?", { weather: forecast() });
  geminiEmpty = false;
  assert.deepEqual(sent.map((s) => s.host), ["generativelanguage.googleapis.com", "api.groq.com", "api.groq.com"]);
  assert.equal(r.said, "Tomorrow in Paris: 18°C, dry.");
  assert.deepEqual(r.recorded, [{ provider: "gemini", tokens: 800 }, { provider: "groq", tokens: 900 + 40 + 2000 + 15 }]);
});

test("without the forecast, a free reply is asked as before: one streamed call, one request reserved", async () => {
  sent.length = 0;
  const r = await ask("Tell me a joke about cats");
  assert.deepEqual(sent.map((s) => s.host), ["api.groq.com"]);
  const body = sent[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "stream", "stream_options"]);
  assert.equal(body.stream, true);
  assert.deepEqual(r.reserved, [{ provider: "groq", count: 1 }]);
  // The companion's own instructions are used as they are.
  sent.length = 0;
  await ask("hello", { systemPrompt: "You are the companion." });
  assert.equal((sent[0].body.messages as { content: string }[])[0].content, "You are the companion.");
});
