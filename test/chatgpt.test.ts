import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { register } from "node:module";
import { startStandIns } from "./support/research-stand-ins.ts";

/*
 * OpenAI's ChatGPT models in chat (engines/openai-chat.ts): what a reply costs and holds, what is sent
 * to OpenAI and never sent, when Claude answers instead and why, and what a busy, refused, cut or
 * stopped reply is charged. OpenAI is a stand-in on a local server; Claude is the research stand-in.
 */
register("./support/route-hooks.mjs", import.meta.url);

const stand = await startStandIns();
stand.install();
after(() => stand.close());

type GptScript = {
  text?: string;
  refusal?: string;
  usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
  // How the stream ends: completed (default), incomplete with a reason, failed, or not at all.
  end?: "completed" | "incomplete" | "failed" | "none";
  reason?: string;
  // OpenAI answers with this error instead.
  status?: number;
  // The stream waits for it after its words (to press Stop then).
  hold?: Promise<unknown>;
};
const openai = { replies: [] as GptScript[], sent: [] as Record<string, unknown>[], counted: [] as Record<string, unknown>[], count: 2000, countStatus: 0 };
const KEY = "sk-openai-test";
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: "Incorrect API key" } }, 401);
    if (req.url === "/v1/responses/input_tokens") {
      openai.counted.push(body);
      return openai.countStatus ? json({ error: { message: "scripted" } }, openai.countStatus) : json({ object: "response.input_tokens", input_tokens: openai.count });
    }
    if (req.url !== "/v1/responses") return json({}, 404);
    openai.sent.push(body);
    const r = openai.replies.shift() ?? { text: "done" };
    if (r.status) return json({ error: { message: "scripted", type: "server_error" } }, r.status);
    res.writeHead(200, { "content-type": "text/event-stream" });
    // As OpenAI sends them: an event line, then the data, then a blank line.
    const send = (e: Record<string, unknown>) => res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ type: "response.created", response: { id: "resp_1", status: "in_progress" } });
    send({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } });
    send({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1" } });
    for (const piece of (r.text ?? "").match(/[^]{1,6}/g) ?? []) send({ type: "response.output_text.delta", delta: piece });
    if (r.refusal) send({ type: "response.refusal.delta", delta: r.refusal });
    void (async () => {
      if (r.hold) await r.hold.catch(() => {});
      const usage = r.usage ?? { input_tokens: 2000, output_tokens: 300, input_tokens_details: { cached_tokens: 0 } };
      if (r.end === "failed") send({ type: "response.failed", response: { error: { code: "server_error", message: "scripted" } } });
      else if (r.end === "incomplete") send({ type: "response.incomplete", response: { usage, incomplete_details: { reason: r.reason ?? "max_output_tokens" } } });
      else if (r.end !== "none") send({ type: "response.completed", response: { usage } });
      res.end();
    })();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());

process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `${stand.origin}/anthropic`;
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
for (const name of ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "VERCEL_ENV", "RESEND_API_KEY", "FLASH_APP_URL", "CONNECTOR_KEYS", "FRED_API_KEY", "SEARXNG_URL"]) {
  delete process.env[name];
}
const logged: string[] = [];
for (const level of ["log", "error", "warn", "info"] as const) console[level] = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));

const { afterwards } = await import("./support/next-server.mjs");
const { one, run: sql } = await import("../src/lib/server/db.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");
const { CLAUDE_PRICES, MARKUP, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, callCost, claudePrice, creditsFor, planHold, tokensMaxCents } = await import("../src/lib/credits.ts");
const { GPT_BUSY, GPT_MODELS, GPT_REFUSED, gptChoice, gptCostCents, gptInstructions, safetyId, toInput } = await import("../src/lib/engines/openai-chat.ts");
const { GPT_PICKS, LEVELS, autoLevel, isModelPick, levelName } = await import("../src/lib/levels.ts");
const { defaultChoice } = await import("../src/lib/engines/claude.ts");
const { english } = await import("../src/lib/i18n.ts");
const { requestStop } = await import("../src/lib/server/stops.ts");

beforeEach(async () => {
  stand.reset();
  openai.replies = [];
  openai.sent = [];
  openai.counted = [];
  openai.count = 2000;
  openai.countStatus = 0;
  process.env.OPENAI_API_KEY = KEY;
  await sql("DELETE FROM rate_limits");
});

const ORIGIN = "http://localhost";
async function account(id: string, credits: number) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, 1)", [id, `${id}@example.com`]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, 0)", [id, credits, `free:${id}:${month}`]);
  await sql("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, 'Notes', '[]', 0)", [`proj_${id}`, id]);
  return { id, cookie: `flash_session=${token}`, projectId: `proj_${id}` };
}
const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))!.b);

type ChatEvent = { type: string; delta?: string; message?: string; reason?: string; engine?: string; model?: string; modelWhy?: string; credits?: number; free?: boolean };
let n = 0;
/** A chat request as the page sends it, read to its end (onEvent may press Stop). */
async function chat(who: Awaited<ReturnType<typeof account>>, content: string, body: Record<string, unknown> = {}, onEvent?: (e: ChatEvent, replyId: string) => void) {
  const replyId = `r${n}${Date.now().toString(36)}`;
  const res = await chatRoute.POST(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie },
      body: JSON.stringify({
        projectId: who.projectId,
        replyId,
        userMessage: { id: `u${n++}${Date.now().toString(36)}`, role: "user", content },
        afterId: null,
        engine: "text",
        level: "gpt-sol",
        messages: [{ role: "user", content }],
        ...body,
      }),
    }),
  );
  const events: ChatEvent[] = [];
  if (!res.ok || !res.body) {
    await afterwards();
    return { status: res.status, events, error: await res.text() };
  }
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((l) => l.trim())) {
      const e = JSON.parse(line) as ChatEvent;
      events.push(e);
      onEvent?.(e, replyId);
    }
  }
  await afterwards();
  return { status: res.status, events, error: "" };
}
const said = (events: ChatEvent[]) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");
const header = (events: ChatEvent[]) => events.filter((e) => e.type === "route").at(-1)!;
const charged = (events: ChatEvent[]) => events.find((e) => e.type === "cost")?.credits;
type GptBody = { model: string; instructions: string; input: { role: string; content: unknown }[]; reasoning: { effort: string }; max_output_tokens: number; store: boolean; stream: boolean; safety_identifier?: string };
const gptSent = () => openai.sent as unknown as GptBody[];

test("the prices are OpenAI's, with the long-prompt rate past 272,000 tokens, and every pick names a priced model", () => {
  assert.deepEqual(CLAUDE_PRICES["gpt-6.1-sol"], { input: 200, output: 1000, long: { over: 272_000, input: 400, output: 1500 } });
  assert.deepEqual(CLAUDE_PRICES["gpt-6-luna"], { input: 10, output: 50, long: { over: 272_000, input: 20, output: 75 } });
  for (const g of GPT_PICKS) assert.ok(Object.hasOwn(CLAUDE_PRICES, GPT_MODELS[g.id]), g.id);
  assert.equal(MARKUP, 2.5);
  // A plain reply: 10,000 tokens read, 2,000 written.
  assert.equal(gptCostCents("gpt-6.1-sol", { input_tokens: 10_000, output_tokens: 2000 }), 4);
  assert.equal(gptCostCents("gpt-6-luna", { input_tokens: 10_000, output_tokens: 2000 }), 0.2);
  // Past 272,000 tokens read, the whole reply is at the long rate.
  assert.equal(gptCostCents("gpt-6.1-sol", { input_tokens: 300_000, output_tokens: 1000 }), 121.5);
  assert.equal(gptCostCents("gpt-6.1-sol", { input_tokens: 272_000, output_tokens: 1000 }), 55.4, "at 272,000 it's still the usual rate");
  // Cached tokens are part of input_tokens: read at a tenth, written at 1.25 times.
  assert.equal(gptCostCents("gpt-6.1-sol", { input_tokens: 10_000, output_tokens: 0, input_tokens_details: { cached_tokens: 8000 } }), 0.56);
  assert.equal(gptCostCents("gpt-6.1-sol", { input_tokens: 10_000, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 10_000 } }), 2.5);
  // Never below what reading every token at the full price would make OpenAI's own cache discount worth.
  assert.ok(gptCostCents("gpt-6.1-sol", { input_tokens: 100, output_tokens: 0, input_tokens_details: { cached_tokens: 500 } }) >= 0);
});

test("a ChatGPT hold never runs at a loss: at its worst, what it may spend is within what's held, at every balance and length", () => {
  for (const g of GPT_PICKS) {
    const model = GPT_MODELS[g.id];
    for (const engine of ["text", "code", "translate", "docs"] as const) {
      for (const input of [500, 20_000, 200_000, 272_001, 400_000]) {
        const scale = claudePrice(model, input).output / claudePrice(defaultChoice(engine).model, input).output;
        for (const available of [0, 3, 40, 300, 5000, 1_000_000]) {
          const hold = planHold(engine, model, input, available, scale, 0);
          assert.ok(hold.held >= hold.needed);
          if (available < hold.needed) continue;
          // As for Claude (see connect-hold.test.ts): reading the input once and writing every token allowed.
          const cost = callCost(engine, model, input, hold.fallback);
          const worst = cost.inputCents + (hold.maxTokens * cost.outputPrice) / 1e6;
          assert.ok(worst <= hold.capCents + 1e-9, `${model} ${engine} ${input} at ${available}: ${worst} > ${hold.capCents}`);
          // And with room to spare: even the framing around the request and its rounding stay within what's held.
          assert.ok(creditsFor(tokensMaxCents(model, input, hold.maxTokens)) <= hold.held, `${model} ${engine} ${input} at ${available}`);
          assert.ok(hold.maxTokens >= (MIN_OUTPUT_TOKENS[engine] ?? 1500) && hold.maxTokens <= MAX_OUTPUT_TOKENS);
          assert.equal(hold.fallback, false, "ChatGPT has no refusal fallback to pay for");
        }
      }
    }
  }
});

test("Luna thinks less unless the request has numbers to get right; Sol thinks hardest on code", () => {
  assert.equal(gptChoice("text", "gpt-luna").effort, "low");
  assert.equal(gptChoice("text", "gpt-luna", { careful: true }).effort, "medium");
  assert.equal(gptChoice("text", "gpt-sol").effort, "medium");
  assert.equal(gptChoice("code", "gpt-sol").effort, "high");
  assert.equal(gptChoice("docs", "gpt-sol").model, "gpt-6.1-sol");
  assert.ok(isModelPick("gpt-sol") && isModelPick("ultra") && !isModelPick("gpt-4"));
  assert.equal(levelName("gpt-luna"), "GPT-6 Luna");
  assert.equal(new Set([...LEVELS, ...GPT_PICKS].map((l) => l.name)).size, LEVELS.length + GPT_PICKS.length, "names tell them apart in a reply's header");
});

test("a conversation as OpenAI reads it: pictures and PDFs as files, other files as text, an app's code on its reply, no empty turns", () => {
  const png = Buffer.from("png-bytes").toString("base64");
  const pdf = Buffer.from("%PDF-1.7").toString("base64");
  const input = toInput([
    { role: "user", content: "What's in these?", attachment: { name: "cat.png", mediaType: "image/png", data: png }, more: [{ name: "Menu.pdf", mediaType: "application/pdf", data: pdf }, { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("Buy flour").toString("base64") }] },
    { role: "assistant", content: "Here's your page.", app: "<h1>Hi</h1>" },
    { role: "assistant", content: "  " },
    { role: "user", content: "Thanks" },
  ] as never);
  assert.equal(input.length, 3);
  assert.deepEqual(input[0], {
    role: "user",
    content: [
      { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "auto" },
      { type: "input_file", filename: "Menu.pdf", file_data: `data:application/pdf;base64,${pdf}` },
      { type: "input_text", text: "File: notes.txt\n\nBuy flour" },
      { type: "input_text", text: "Attached files, in order: cat.png, Menu.pdf, notes.txt.\n\nWhat's in these?" },
    ],
  });
  assert.deepEqual(input[1], { role: "assistant", content: "Here's your page.\n\n```html\n<h1>Hi</h1>\n```" });
  assert.deepEqual(input[2], { role: "user", content: "Thanks" });
});

test("a ChatGPT pick on Write is answered by OpenAI, priced from its count and charged what it really cost", async () => {
  const who = await account("gpt-write", 500);
  openai.replies.push({ text: "Autumn leaves drift down.", usage: { input_tokens: 2000, output_tokens: 300 } });
  const { status, events } = await chat(who, "Write a short poem about autumn leaves");
  assert.equal(status, 200);
  assert.equal(said(events), "Autumn leaves drift down.");
  assert.equal(header(events).model, "GPT-6.1 Sol");
  assert.equal(header(events).modelWhy, "You picked GPT-6.1 Sol.");
  assert.equal(stand.state.claude.sent.length, 0, "Claude isn't asked to write it");
  // What was sent: the model the user picked, kept out of OpenAI's storage, a hashed account id, and Flash's own system prompt naming the model.
  const [body] = gptSent();
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.reasoning.effort, "medium");
  assert.equal(body.safety_identifier, safetyId(who.id));
  assert.ok(!body.safety_identifier!.includes(who.id) && !JSON.stringify(body).includes(`${who.id}@example.com`), "no id or email of the user's");
  assert.match(body.instructions, /OpenAI's GPT-6\.1 Sol model, which the user picked in Flash/);
  assert.deepEqual(body.input, [{ role: "user", content: "Write a short poem about autumn leaves" }]);
  assert.ok(!("temperature" in body) && !("tools" in body));
  // Counted by OpenAI with the same instructions and input, and held from that count.
  assert.equal(openai.counted.length, 1);
  assert.equal(openai.counted[0].instructions, body.instructions);
  assert.deepEqual(openai.counted[0].input, body.input);
  const scale = claudePrice("gpt-6.1-sol", 2000).output / claudePrice(defaultChoice("text").model, 2000).output;
  assert.equal(body.max_output_tokens, planHold("text", "gpt-6.1-sol", 2000, 500, scale, 0).maxTokens);
  // Charged at cost × 2.5, from OpenAI's usage: 2,000 read and 300 written on Sol is 0.7 cents, so 2 credits.
  const cost = gptCostCents("gpt-6.1-sol", { input_tokens: 2000, output_tokens: 300 });
  assert.equal(charged(events), creditsFor(cost));
  assert.equal(await balance(who.id), 500 - creditsFor(cost));
  const used = await one<{ provider: string; model: string; cost_cents: number }>("SELECT provider, model, cost_cents FROM usage WHERE user_id = ? ORDER BY rowid DESC LIMIT 1", [who.id]);
  assert.deepEqual(used && { provider: used.provider, model: used.model }, { provider: "openai", model: "gpt-6.1-sol" });
});

test("Luna on Code, and on Translate with a file: the effort and the file go with it", async () => {
  const who = await account("gpt-luna", 300);
  openai.replies.push({ text: "function add(a, b) { return a + b; }" }, { text: "Bonjour" });
  const coded = await chat(who, "Write a JavaScript function that adds two numbers", { engine: "code", level: "gpt-luna" });
  assert.equal(coded.status, 200);
  assert.equal(header(coded.events).model, "GPT-6 Luna");
  assert.equal(gptSent()[0].model, "gpt-6-luna");
  assert.equal(gptSent()[0].reasoning.effort, "low");
  const data = Buffer.from("Hello").toString("base64");
  const translated = await chat(who, "Translate this to French", {
    engine: "translate",
    level: "gpt-luna",
    messages: [{ role: "user", content: "Translate this to French", attachment: { name: "hello.txt", mediaType: "text/plain", data } }],
  });
  assert.equal(translated.status, 200);
  assert.deepEqual(gptSent()[1].input[0].content, [
    { type: "input_text", text: "File: hello.txt\n\nHello" },
    { type: "input_text", text: "Translate this to French" },
  ]);
});

test("Claude answers instead, saying why, where ChatGPT can't: Research, apps, no key, a weather forecast, a chat that used connected accounts", async () => {
  const who = await account("gpt-fallback", 2000);
  const check = async (content: string, body: Record<string, unknown>, why: string) => {
    stand.reset();
    openai.sent = [];
    openai.counted = [];
    const { status, events } = await chat(who, content, body);
    assert.equal(status, 200, why);
    assert.equal(openai.sent.length, 0, `${why}: nothing goes to OpenAI`);
    assert.equal(openai.counted.length, 0, `${why}: not even to count`);
    assert.ok(stand.state.claude.sent.length >= 1, why);
    assert.ok(!["GPT-6.1 Sol", "GPT-6 Luna"].includes(header(events).model ?? ""), why);
    assert.equal(header(events).modelWhy, why);
  };
  // The level Auto picks for it, which answers instead.
  const level = (body: Record<string, unknown>, content: string) => levelName(autoLevel((body.engine as "search" | undefined) ?? "text", content).level);
  let content = "Compare the best electric cars of this year";
  await check(content, { engine: "search" }, english("{model} doesn't do Research, apps or slides in Flash yet, so {level} answered.").replace("{model}", "GPT-6.1 Sol").replace("{level}", level({ engine: "search" }, content)));
  content = "Write a short poem about the sea";
  delete process.env.OPENAI_API_KEY;
  await check(content, {}, `GPT-6.1 Sol isn't available right now, so ${level({}, content)} answered.`);
  process.env.OPENAI_API_KEY = KEY;
  const used = [
    { role: "user", content: "What's on my calendar?" },
    { role: "assistant", content: "You have a dentist at 3.", usedConnector: true },
    { role: "user", content },
  ];
  await check(content, { messages: used }, `This chat used your connected accounts, which stay with Claude, so ${level({}, content)} answered.`);
  // A forecast asked for in so many words.
  content = "What's the weather forecast for Paris tomorrow?";
  stand.state.claude.router = "weather";
  await check(content, { engine: "auto" }, `GPT-6.1 Sol can't use live forecasts, company filings, economic data or your connected accounts in Flash yet, so ${level({}, content)} answered.`);
});

test("a weather word alone doesn't keep ChatGPT from answering: it answers without the forecast", async () => {
  const who = await account("gpt-rain", 300);
  openai.replies.push({ text: "Rain on the window." });
  const { status, events } = await chat(who, "Write a poem about the rain");
  assert.equal(status, 200);
  assert.equal(header(events).model, "GPT-6.1 Sol");
  assert.ok(!gptSent()[0].instructions.includes("forecast tool"), "no forecast line");
});

test("OpenAI busy or refusing the request: the user is told, nothing is charged, and Claude isn't called behind their back", async () => {
  const who = await account("gpt-busy", 300);
  openai.replies.push({ status: 429 }, { status: 400 });
  const busy = await chat(who, "Write a haiku");
  assert.equal(busy.status, 200);
  assert.equal(busy.events.find((e) => e.type === "error")?.message?.startsWith(english(GPT_BUSY)), true);
  const refused = await chat(who, "Write a haiku");
  assert.equal(refused.events.find((e) => e.type === "error")?.message?.startsWith(english(GPT_REFUSED)), true);
  assert.equal(stand.state.claude.sent.length, 0);
  assert.equal(await balance(who.id), 300, "nothing charged for a reply OpenAI never started");
  assert.ok(!logged.join("\n").includes(KEY), "the key is never logged");
});

test("a count OpenAI couldn't make isn't guessed: nothing is sent or charged", async () => {
  const who = await account("gpt-count", 300);
  openai.countStatus = 500;
  const { status } = await chat(who, "Write a haiku");
  assert.equal(status, 503);
  assert.equal(openai.sent.length, 0);
  assert.equal(await balance(who.id), 300);
});

test("ChatGPT declining, being cut short, or failing part way: Flash's note, charged what ran and never more than held", async () => {
  const who = await account("gpt-ends", 1000);
  openai.replies.push(
    { refusal: "I can't help with that.", usage: { input_tokens: 2000, output_tokens: 40 } },
    { text: "Once upon a time", end: "incomplete", reason: "max_output_tokens", usage: { input_tokens: 2000, output_tokens: 900 } },
    { text: "Once upon", end: "failed" },
  );
  const refused = await chat(who, "Write something");
  assert.ok(!said(refused.events).includes("I can't help with that."), "OpenAI's own words aren't shown");
  assert.ok(said(refused.events).length > 0, "Flash says it couldn't help");
  assert.equal(charged(refused.events), creditsFor(gptCostCents("gpt-6.1-sol", { input_tokens: 2000, output_tokens: 40 })));
  const cut = await chat(who, "Write a long story");
  assert.match(said(cut.events), /^Once upon a time/);
  assert.ok(said(cut.events).length > "Once upon a time".length, "with the note that it was cut short");
  assert.equal(charged(cut.events), creditsFor(gptCostCents("gpt-6.1-sol", { input_tokens: 2000, output_tokens: 900 })));
  const before = await balance(who.id);
  const failed = await chat(who, "Write a long story");
  assert.ok(failed.events.some((e) => e.type === "error"));
  const paid = before - (await balance(who.id));
  // Read once at full price, and what it wrote: never nothing, since OpenAI started it.
  assert.ok(paid >= creditsFor((2000 * 200) / 1e6), `paid ${paid}`);
});

test("Stop while ChatGPT writes: charged for what ran so far, never the whole hold", async () => {
  const who = await account("gpt-stop", 1000);
  let release!: () => void;
  openai.replies.push({ text: "The first lines", hold: new Promise<void>((r) => (release = r)) });
  let stopping = false;
  const { events } = await chat(who, "Write a long story", {}, (e, replyId) => {
    if (e.type !== "text" || !e.delta || stopping) return;
    stopping = true;
    void requestStop(who.id, replyId).then(() => setTimeout(release, 50));
  });
  const paid = charged(events)!;
  assert.ok(events.some((e) => e.type === "stopped"));
  assert.equal(await balance(who.id), 1000 - paid);
  // At least reading the 2,000 tokens counted, and far below what a reply that wrote all it could would cost.
  assert.ok(paid >= creditsFor((2000 * 200) / 1e6), `paid ${paid}`);
  assert.ok(paid < creditsFor(tokensMaxCents("gpt-6.1-sol", 2000, MIN_OUTPUT_TOKENS.text ?? 1500)), `paid ${paid}`);
});

test("the system prompt OpenAI reads names the model the user picked", () => {
  assert.equal(gptInstructions("Be brief.", "gpt-luna"), "Be brief.\n\nThis answer is written by OpenAI's GPT-6 Luna model, which the user picked in Flash. If they ask which AI answered, say so.");
});
