import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FRED_KEY, PASSWORD, startStandIns } from "./support/research-stand-ins.ts";

/*
 * The data tools inside the engines: Claude's tool loop (Write and Research) with its per-step check
 * on the credits held, and the free models' one or two rounds of tools. Claude, the free model,
 * SearXNG, the SEC and FRED are stand-ins (see support/research-stand-ins.ts).
 */

const stand = await startStandIns();
stand.install();
after(() => stand.close());

process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `${stand.origin}/anthropic`;
process.env.SEARXNG_URL = "https://searx.test";
process.env.SEARXNG_USERNAME = "flash";
process.env.SEARXNG_PASSWORD = PASSWORD;
process.env.FRED_API_KEY = FRED_KEY;
// One free provider, which takes tools: every free request goes to the stand-in.
process.env.GROQ_API_KEY = "groq-test";
process.env.GROQ_BASE_URL = `${stand.origin}/groq`;
for (const name of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_BASE_URL", "VERCEL_ENV"]) delete process.env[name];

const logged: string[] = [];
for (const level of ["log", "error", "warn"] as const) console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));

const { claudeChoice, defaultChoice, streamSearch, streamText, SEC_LINE, FRED_LINE, system } = await import("../src/lib/engines/claude.ts");
const { streamFreeChat } = await import("../src/lib/engines/free.ts");
const { dataTools } = await import("../src/lib/server/research-tools.ts");
const { forgetTickers } = await import("../src/lib/server/sec.ts");
const { WEATHER_PLAN, planHold, claudePrice, researchPlan } = await import("../src/lib/credits.ts");
const R = await import("../src/lib/research.ts");
const { run: sql } = await import("../src/lib/server/db.ts");

type Event = { type: string; delta?: string; message?: string; items?: { title: string; url: string }[] };
const ask = (content: string) => [{ role: "user" as const, content }];
const collect = async (gen: AsyncGenerator<unknown>) => {
  const events: Event[] = [];
  for await (const e of gen) events.push(e as Event);
  return events;
};
const said = (events: Event[]) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");
const sources = (events: Event[]) => events.filter((e) => e.type === "sources").at(-1)?.items ?? [];
type Sent = { system: string; tools?: { name: string }[]; tool_choice?: { type: string }; max_tokens: number; messages: { role: string; content: unknown }[] };
const claudeSent = () => stand.state.claude.sent as unknown as Sent[];
const lastResults = (body: Sent) => JSON.stringify(body.messages.at(-1)?.content);

beforeEach(async () => {
  stand.reset();
  forgetTickers();
  for (const table of ["source_cache", "free_quota", "free_user_quota", "rate_limits"]) await sql(`DELETE FROM ${table}`);
});

test("Write with SEC EDGAR: Claude asks for Apple's revenue, reads EDGAR's figures, and the filing is listed under the answer", async () => {
  const data = dataTools({ filings: true }, { userId: "u1" });
  const choice = claudeChoice("text", "ascend");
  const hold = planHold("text", choice.model, 6000, 500, 1, 0, WEATHER_PLAN);
  const budget = { maxTokens: hold.maxTokens, capCents: hold.capCents, byCredits: hold.byCredits };
  stand.state.claude.replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "sec_financial_facts", input: { ticker: "AAPL", concepts: ["revenue"], count: 3 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Apple's revenue: $391.0 billion in fiscal 2024." }], stop: "end_turn" },
  );
  const costs: number[] = [];
  const events = await collect(
    streamText(ask("What was Apple's revenue for the last 3 years?"), "", "text", (_p, _m, cents) => costs.push(cents), budget, choice, undefined, {}, { data }),
  );
  const [first, second] = claudeSent();
  assert.deepEqual(first.tools?.map((t) => t.name), ["sec_company_filings", "sec_financial_facts"]);
  assert.ok(first.system.includes(SEC_LINE) && !first.system.includes(FRED_LINE));
  assert.match(lastResults(second), /391035000000/);
  assert.ok(events.some((e) => e.type === "status" && e.message === "Getting AAPL's reported figures from SEC EDGAR…"));
  assert.match(said(events), /391\.0 billion/);
  assert.equal(sources(events)[0].title, "SEC EDGAR · Apple Inc. · 10-K · 2024-11-01");
  assert.ok(costs.reduce((a, b) => a + b, 0) <= budget.capCents);
  assert.equal(said(events).includes(R.FRED_NOTICE), false, "no FRED notice without FRED data");
  // The same words the hold counted: the system prompt the engine sends is system() with the SEC line.
  assert.equal(first.system, system("", "text", { filings: true }));
});

test("the per-step check holds with the data tools: a round the credits held can't pay for never starts, and a reply stays within its cap", async () => {
  const data = dataTools({ filings: true, economy: true }, { userId: "u1" });
  stand.state.claude.replies.push({ blocks: [{ type: "tool_use", id: "t", name: "fred_series", input: { series_id: "UNRATE" } }], stop: "tool_use" });
  const tight = { maxTokens: 2000, capCents: 1, byCredits: true };
  const costs: number[] = [];
  const events = await collect(streamText(ask("unemployment rate?"), "", "text", (_p, _m, c) => costs.push(c), tight, claudeChoice("text", "ascend"), undefined, {}, { data }));
  assert.equal(claudeSent().length, 1, "no second call it can't pay for");
  assert.ok(costs.reduce((a, b) => a + b, 0) <= tight.capCents);
  assert.match(said(events), /reached what your credits cover/);
  // FRED's data was read, so its notice still goes under what was written.
  assert.ok(said(events).includes(R.FRED_NOTICE));

  // Holds as the chat route makes them, at several balances: every call within the cap, and a call
  // that may still look things up has room for a full answer.
  const input = 3000;
  let checked = 0;
  for (const available of [12, 14, 16, 20, 30, 60]) {
    stand.reset();
    await sql("DELETE FROM source_cache");
    const choice = claudeChoice("text", "ascend");
    const scale = claudePrice(choice.model, input).output / claudePrice(defaultChoice("text").model, input).output;
    const hold = planHold("text", choice.model, input, available, scale, 0, WEATHER_PLAN);
    if (available < hold.needed) continue;
    checked++;
    stand.state.claude.replies.push(
      { blocks: [{ type: "tool_use", id: "a", name: "sec_financial_facts", input: { ticker: "AAPL", concepts: ["revenue", "net_income"] } }], stop: "tool_use", usage: { input_tokens: input, output_tokens: 1500 } },
      { blocks: [{ type: "tool_use", id: "b", name: "fred_series", input: { series_id: "UNRATE", count: 60 } }], stop: "tool_use", usage: { input_tokens: input + 3000, output_tokens: 1500 } },
      { blocks: [{ type: "text", text: "Done." }], stop: "end_turn", usage: { input_tokens: input + 6000, output_tokens: 300 } },
    );
    const spent: number[] = [];
    const budget = { maxTokens: hold.maxTokens, capCents: hold.capCents, byCredits: hold.byCredits };
    await collect(streamText(ask("Apple revenue and unemployment"), "", "text", (_p, _m, c) => spent.push(c), budget, { ...choice, fallback: hold.fallback }, undefined, {}, { data }));
    assert.ok(spent.reduce((a, b) => a + b, 0) <= hold.capCents, `${available} credits: within the cap`);
    for (const body of claudeSent().slice(1)) {
      if (body.tool_choice?.type !== "none") assert.ok(body.max_tokens >= 1500, `${available} credits: room for a full answer`);
    }
    // At most two rounds of tools, as for the forecast: the third call can only answer.
    if (claudeSent().length === 3) assert.equal(claudeSent()[2].tool_choice?.type, "none");
  }
  assert.ok(checked >= 3, `${checked} balances checked`);
});

test("Research with FRED: the series comes back, FRED's notice follows the answer, and its link is listed after the web's", async () => {
  const data = dataTools({ economy: true }, { userId: "u1" });
  const choice = claudeChoice("search", "ascend");
  const hold = planHold("search", choice.model, 6000, 400, 1, 0, researchPlan(true, true));
  stand.state.claude.replies.push(
    { blocks: [{ type: "tool_use", id: "f1", name: "fred_series_search", input: { query: "unemployment rate" } }], stop: "tool_use" },
    { blocks: [{ type: "tool_use", id: "f2", name: "fred_series", input: { series_id: "UNRATE", count: 24 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "US unemployment was 4.3% in September 2026." }], stop: "end_turn" },
  );
  const events = await collect(
    streamSearch(ask("What's the US unemployment rate trend?"), "", undefined, { maxTokens: hold.maxTokens, capCents: hold.capCents }, choice, undefined, {}, { data, quick: true }),
  );
  const sent = claudeSent();
  assert.deepEqual(sent[0].tools?.map((t) => t.name), ["web_search", "web_fetch", "fred_series_search", "fred_series"]);
  assert.ok(sent[0].system.includes(FRED_LINE));
  assert.equal(sent[2].tool_choice?.type, "none", "after two rounds, it answers");
  assert.match(lastResults(sent[2]), /"date\\":\\"2026-09-01\\",\\"value\\":4.3/);
  const text = said(events);
  assert.ok(text.endsWith(R.FRED_NOTE), "FRED's notice, with its terms, under the answer");
  assert.deepEqual(sources(events), [{ title: "FRED® · Unemployment Rate (UNRATE)", url: "https://fred.stlouisfed.org/series/UNRATE" }]);
  // Research never gets the free models' web search: Claude has its own.
  const withWeb = dataTools({ search: true, economy: true }, { userId: "u1" });
  stand.state.claude.replies.push({ blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
  await collect(streamSearch(ask("x"), "", undefined, { maxTokens: hold.maxTokens, capCents: hold.capCents }, choice, undefined, {}, { data: withWeb }));
  assert.equal(claudeSent().at(-1)!.tools!.filter((t) => t.name === "web_search").length, 1);
});

test("a copyrighted FRED series: Claude reads the refusal, and no notice or figure of it follows", async () => {
  const data = dataTools({ economy: true }, { userId: "u1" });
  stand.state.claude.replies.push(
    { blocks: [{ type: "tool_use", id: "c", name: "fred_series", input: { series_id: "SP500" } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "FRED can't show that series." }], stop: "end_turn" },
  );
  const events = await collect(streamText(ask("S&P 500 from FRED"), "", "text", undefined, { maxTokens: 4000, capCents: 50 }, claudeChoice("text", "ascend"), undefined, {}, { data }));
  const result = (claudeSent()[1].messages.at(-1)!.content as { content: string; is_error?: boolean }[])[0];
  assert.deepEqual([result.content, result.is_error], [R.FRED_COPYRIGHT, true]);
  assert.equal(said(events).includes(R.FRED_NOTICE), false);
  assert.equal(stand.state.seen.some((s) => s.path === "/series/observations"), false);
});

// ---------------------------------------------------------------------------------------------
// The free models

const reserves: [string, number][] = [];
const reserve = async (provider: string, _limits: unknown, count = 1) => (reserves.push([provider, count]), true);
const record = async () => {};
type FreeBody = { messages: { role: string; content: string; name?: string }[]; tools?: { function: { name: string } }[]; tool_choice?: string; stream: boolean };
const freeSent = () => stand.state.free.sent as unknown as FreeBody[];

test("the free model searches the web: Basic auth to SearXNG, the results numbered for it to cite, and the links listed in that order", async () => {
  reserves.length = 0;
  const used: string[] = [];
  stand.state.free.replies.push({ calls: [{ name: "web_search", args: { query: "news today" } }] }, { text: "Today's top story [1], and markets rose [2]." });
  const tools = dataTools({ search: true }, { userId: "free-1", language: "en" });
  const events = await collect(streamFreeChat(ask("what happened in the news today?"), "", "text", reserve, record, () => {}, { tools, onTool: (n) => used.push(n) }));
  const [first, second] = freeSent();
  assert.deepEqual(first.tools?.map((t) => t.function.name), ["web_search"]);
  assert.equal(first.tool_choice, "auto");
  assert.match(first.messages[0].content, /with a web_search tool/);
  assert.equal(second.tool_choice, "none");
  const result = JSON.parse(second.messages.find((m) => m.role === "tool")!.content) as { results: { n: number; url: string }[] };
  assert.deepEqual(result.results.map((r) => [r.n, r.url]), [
    [1, "https://news.example.com/today"],
    [2, "https://news.example.org/markets"],
  ]);
  assert.deepEqual(sources(events).map((s) => s.url), ["https://news.example.com/today", "https://news.example.org/markets"]);
  assert.ok(events.some((e) => e.type === "status" && e.message === "Searching the web for news today…"));
  assert.deepEqual(used, ["web_search"]);
  assert.deepEqual(reserves, [["groq", 2]]);
  const searx = stand.state.seen.find((s) => s.service === "searx")!;
  assert.equal(searx.headers.authorization, `Basic ${Buffer.from(`flash:${PASSWORD}`).toString("base64")}`);
  assert.equal(JSON.stringify([events, logged, freeSent()]).includes(PASSWORD), false);
});

test("SearXNG down: the free model is told it couldn't search, still answers, and nothing is listed as a source", async () => {
  stand.state.searx.status = 503;
  const used: string[] = [];
  stand.state.free.replies.push({ calls: [{ name: "web_search", args: { query: "news today" } }] }, { text: "I couldn't search the web just now." });
  const tools = dataTools({ search: true }, { userId: "free-2" });
  const events = await collect(streamFreeChat(ask("what happened in the news today?"), "", "text", reserve, record, () => {}, { tools, onTool: (n) => used.push(n) }));
  assert.equal(freeSent()[1].messages.find((m) => m.role === "tool")!.content, R.SEARCH_FAILED);
  assert.match(said(events), /couldn't search/);
  assert.deepEqual(sources(events), []);
  assert.deepEqual(used, []);
});

test("the free model finds a FRED series, then reads it in one more round, and FRED's notice follows", async () => {
  reserves.length = 0;
  stand.state.free.replies.push(
    { calls: [{ name: "fred_series_search", args: { query: "unemployment rate" } }] },
    { calls: [{ name: "fred_series", args: { series_id: "UNRATE", count: 12 } }] },
    { text: "Unemployment was 4.3% in September 2026." },
  );
  const events = await collect(streamFreeChat(ask("US unemployment rate trend"), "", "text", reserve, record, () => {}, { tools: dataTools({ economy: true }, { userId: "free-3" }) }));
  assert.deepEqual(reserves, [["groq", 2], ["groq", 1]], "the extra round is reserved on its own");
  assert.equal(freeSent().length, 3);
  assert.ok(said(events).endsWith(R.FRED_NOTE));
  assert.deepEqual(sources(events).map((s) => s.url), ["https://fred.stlouisfed.org/series/UNRATE"]);

  // No room left in the provider's day for the extra round: it answers with what it found.
  stand.reset();
  const once = async (_p: string, _l: unknown, count = 1) => count === 2;
  stand.state.free.replies.push({ calls: [{ name: "fred_series_search", args: { query: "unemployment rate" } }] });
  await collect(streamFreeChat(ask("US unemployment rate trend"), "", "text", once, record, () => {}, { tools: dataTools({ economy: true }, { userId: "free-3" }) }));
  assert.deepEqual(freeSent().map((b) => b.stream), [false, true]);
});

test("a free provider without tools gets none, and is told it can't search", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.OPENROUTER_API_KEY = "or-test";
  process.env.OPENROUTER_BASE_URL = `${stand.origin}/groq`;
  try {
    await collect(streamFreeChat(ask("news today?"), "", "text", reserve, record, () => {}, { tools: dataTools({ search: true, filings: true }, { userId: "free-4" }) }));
    assert.equal(freeSent().length, 1);
    assert.equal(freeSent()[0].tools, undefined);
    assert.match(freeSent()[0].messages[0].content, /can't search the web/);
  } finally {
    process.env.GROQ_API_KEY = "groq-test";
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
  }
});
