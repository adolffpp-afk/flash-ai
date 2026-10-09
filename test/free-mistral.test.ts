import { test } from "node:test";
import assert from "node:assert/strict";

// Only OpenRouter and Mistral are set up here, so the tests can tell which one answered.
process.env.OPENROUTER_API_KEY = "or";
process.env.MISTRAL_API_KEY = "mistral-key";
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.CLOUDFLARE_API_TOKEN;
const { CHAT_PROVIDERS, streamFreeChat } = await import("../src/lib/engines/free.ts");

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const sent: Sent[] = [];
let openRouterStatus = 200;
let mistralStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
  if (String(url).includes("openrouter")) {
    if (openRouterStatus !== 200) return new Response('{"error":{"code":429}}', { status: openRouterStatus });
    return new Response('data: {"choices":[{"delta":{"content":"From OpenRouter"}}]}\n\ndata: [DONE]\n\n');
  }
  if (mistralStatus !== 200) return new Response('{"detail":"Requests rate limit exceeded"}', { status: mistralStatus });
  // Mistral's stream: OpenAI-style chunks, with the token counts on the last one.
  const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  return new Response(
    chunk({ id: "c", object: "chat.completion.chunk", model: "mistral-small-latest", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) +
      chunk({ id: "c", object: "chat.completion.chunk", model: "mistral-small-latest", choices: [{ index: 0, delta: { content: "Bonjour" }, finish_reason: null }] }) +
      chunk({
        id: "c",
        object: "chat.completion.chunk",
        model: "mistral-small-latest",
        choices: [{ index: 0, delta: { content: " le monde" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 90, completion_tokens: 6, total_tokens: 96 },
      }) +
      "data: [DONE]\n\n",
  );
}) as typeof fetch;

async function ask() {
  const reserved: { provider: string; requests: number; tokens: number }[] = [];
  const recorded: { provider: string; tokens: number }[] = [];
  const used: string[] = [];
  let said = "";
  let error = "";
  try {
    const reply = streamFreeChat(
      [{ role: "user" as const, content: "say hello in French" }],
      "",
      "text",
      async (provider, limits) => (reserved.push({ provider, ...limits }), true),
      async (provider, tokens) => void recorded.push({ provider, tokens }),
      (label, provider) => used.push(`${provider}: ${label}`),
      undefined,
      "FR",
    );
    for await (const e of reply) if (e.type === "text") said += e.delta;
  } catch (err) {
    error = (err as Error).message;
  }
  return { said, error, reserved, recorded, used };
}

test("Mistral is the last free backup, and answers only when the others are busy", async () => {
  assert.equal(CHAT_PROVIDERS.at(-1)?.id, "mistral");
  sent.length = 0;
  const first = await ask();
  assert.equal(first.said, "From OpenRouter");
  assert.equal(sent.length, 1, "Mistral isn't asked while OpenRouter answers");

  openRouterStatus = 429;
  sent.length = 0;
  const r = await ask();
  openRouterStatus = 200;
  assert.equal(r.said, "Bonjour le monde");
  assert.deepEqual(r.used, ["mistral: Mistral Small"]);
  assert.deepEqual(sent.map((s) => new URL(s.url).hostname), ["openrouter.ai", "api.mistral.ai"]);
  // Under its daily caps, and with its own row of usage.
  assert.deepEqual(r.reserved.at(-1), { provider: "mistral", requests: 500, tokens: 2_000_000 });
  assert.deepEqual(r.recorded, [{ provider: "mistral", tokens: 96 }]);
});

test("Mistral gets the parameters it accepts, and nothing else", async () => {
  openRouterStatus = 503;
  sent.length = 0;
  await ask();
  openRouterStatus = 200;
  const call = sent.find((s) => s.url.includes("mistral"))!;
  assert.equal(call.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(call.headers.Authorization, "Bearer mistral-key");
  assert.deepEqual(Object.keys(call.body).sort(), ["max_tokens", "messages", "model", "stream"]);
  assert.equal(call.body.model, "mistral-small-latest");
  assert.equal(call.body.stream, true);
  // The others still ask for token counts.
  const openRouter = sent.find((s) => s.url.includes("openrouter"))!;
  assert.deepEqual(openRouter.body.stream_options, { include_usage: true });
});

test("when Mistral is busy too, the user gets the free-models-busy message", async () => {
  openRouterStatus = 429;
  mistralStatus = 429;
  const r = await ask();
  openRouterStatus = 200;
  mistralStatus = 200;
  assert.equal(r.said, "");
  assert.match(r.error, /free models are busy/);
});

test.after(() => {
  globalThis.fetch = realFetch;
});
