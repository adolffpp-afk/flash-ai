import { test } from "node:test";
import assert from "node:assert/strict";

// Only Gemini and OpenRouter are set up here, so the tests can tell which one answered.
process.env.GEMINI_API_KEY = "AQ.test-key";
process.env.OPENROUTER_API_KEY = "or";
delete process.env.GROQ_API_KEY;
delete process.env.CLOUDFLARE_API_TOKEN;
const { CHAT_PROVIDERS, geminiFreeServes, streamFreeChat } = await import("../src/lib/engines/free.ts");
const { FREE_PROVIDERS, countryOf } = await import("../src/lib/server/free.ts");

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const sent: Sent[] = [];
// What the stand-in providers answer: Gemini's own stream, or OpenRouter's OpenAI-style one.
let geminiStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
  if (String(url).includes("generativelanguage")) {
    if (geminiStatus !== 200) return new Response('{"error":{"code":429}}', { status: geminiStatus });
    const chunk = (parts: object[], usage?: object) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts } }], ...(usage && { usageMetadata: usage }) })}\r\n\r\n`;
    return new Response(
      chunk([{ text: "Planning the answer", thought: true }]) +
        chunk([{ text: "Bonjour" }]) +
        chunk([{ text: " le monde" }], { promptTokenCount: 120, candidatesTokenCount: 5, thoughtsTokenCount: 30 }),
    );
  }
  return new Response('data: {"choices":[{"delta":{"content":"From OpenRouter"}}]}\n\ndata: [DONE]\n\n');
}) as typeof fetch;

async function ask(country: string) {
  const reserved: { provider: string; requests: number }[] = [];
  const recorded: { provider: string; tokens: number }[] = [];
  const used: string[] = [];
  const history = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "Hi! How can I help?" },
    { role: "user" as const, content: "say hello in French" },
  ];
  let said = "";
  let error = "";
  try {
    const reply = streamFreeChat(
      history,
      "",
      "text",
      async (provider, limits) => (reserved.push({ provider, requests: limits.requests }), true),
      async (provider, tokens) => void recorded.push({ provider, tokens }),
      (label, provider) => used.push(`${provider}: ${label}`),
      undefined,
      country,
    );
    for await (const e of reply) if (e.type === "text") said += e.delta;
  } catch (err) {
    error = (err as Error).message;
  }
  return { said, error, reserved, recorded, used };
}

test("Gemini's free tier answers on its own endpoint, with thinking left out of the answer", async () => {
  sent.length = 0;
  const r = await ask("US");
  assert.equal(r.said, "Bonjour le monde");
  assert.deepEqual(r.used, ["gemini: Gemini Flash-Lite"]);
  assert.deepEqual(r.reserved, [{ provider: "gemini", requests: 450 }], "under the 500 a day of the free tier");
  assert.deepEqual(r.recorded, [{ provider: "gemini", tokens: 155 }]);
  const call = sent[0];
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse");
  // AI Studio's newer keys work in this header; there's no Bearer token to mix them up with.
  assert.equal(call.headers["x-goog-api-key"], "AQ.test-key");
  assert.equal(call.headers.Authorization, undefined);
  const body = call.body as { systemInstruction: { parts: { text: string }[] }; contents: { role: string; parts: { text: string }[] }[]; generationConfig: object };
  assert.match(body.systemInstruction.parts[0].text, /You are Flash/);
  assert.deepEqual(
    body.contents.map((c) => [c.role, c.parts[0].text]),
    [
      ["user", "hello"],
      ["model", "Hi! How can I help?"],
      ["user", "say hello in French"],
    ],
  );
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 4000 });
  // No sampling settings, which newer Gemini models reject.
  assert.ok(!("temperature" in body.generationConfig));
});

test("people in Europe, the UK, Switzerland or an unknown place never reach Gemini's free tier", async () => {
  for (const country of ["FR", "DE", "IE", "NO", "IS", "LI", "GB", "CH", "", "CN", "RU", "HK", "x", "USA"]) {
    sent.length = 0;
    const r = await ask(country);
    assert.equal(r.said, "From OpenRouter", country);
    assert.ok(sent.every((s) => !s.url.includes("generativelanguage")), country);
    assert.ok(r.reserved.every((x) => x.provider !== "gemini"), `${country}: nothing taken from Gemini's allowance`);
  }
  for (const country of ["US", "CA", "BR", "IN", "NG", "JP", "AU", "MX"]) assert.ok(geminiFreeServes(country), country);
  assert.ok(geminiFreeServes("us".toUpperCase()));
});

test("a busy Gemini hands the request to the next free model", async () => {
  geminiStatus = 429;
  sent.length = 0;
  const r = await ask("US");
  geminiStatus = 200;
  assert.equal(r.said, "From OpenRouter");
  assert.deepEqual(sent.map((s) => new URL(s.url).hostname), ["generativelanguage.googleapis.com", "openrouter.ai"]);
});

test("Gemini comes after Groq, and its usage has its own daily row", () => {
  assert.deepEqual(CHAT_PROVIDERS.map((p) => p.id), ["groq", "gemini", "openrouter", "cloudflare", "mistral"]);
  assert.deepEqual(FREE_PROVIDERS, ["groq", "gemini", "openrouter", "cloudflare", "mistral"]);
  assert.equal(countryOf(new Request("http://x", { headers: { "x-vercel-ip-country": "ca" } })), "CA");
  assert.equal(countryOf(new Request("http://x")), "");
});

test.after(() => {
  globalThis.fetch = realFetch;
});
