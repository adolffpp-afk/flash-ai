import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { register } from "node:module";
import { BASIC, FRED_KEY, PASSWORD, startStandIns } from "./support/research-stand-ins.ts";

/*
 * Web search, SEC EDGAR and FRED through Flash's own chat route (POST /api/chat): who gets which tool,
 * what the reply's header says, what a hold pays for, and that nothing secret is ever shown. Claude,
 * the free model, SearXNG, the SEC and FRED are stand-ins (see support/research-stand-ins.ts).
 */
register("./support/route-hooks.mjs", import.meta.url);

const stand = await startStandIns();
stand.install();
after(() => stand.close());

process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `${stand.origin}/anthropic`;
process.env.GROQ_API_KEY = "groq-test";
process.env.GROQ_BASE_URL = `${stand.origin}/groq`;
const RESEARCH_ENV = { SEARXNG_URL: "https://searx.test", SEARXNG_USERNAME: "flash", SEARXNG_PASSWORD: PASSWORD, FRED_API_KEY: FRED_KEY };
Object.assign(process.env, RESEARCH_ENV);
for (const name of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_BASE_URL", "VERCEL_ENV", "RESEND_API_KEY", "FLASH_APP_URL", "CONNECTOR_KEYS"]) {
  delete process.env[name];
}

const logged: string[] = [];
for (const level of ["log", "error", "warn", "info"] as const) console[level] = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));

const { afterwards } = await import("./support/next-server.mjs");
const { one, run: sql } = await import("../src/lib/server/db.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");
const { claudeChoice, defaultChoice, SEC_LINE, FRED_LINE } = await import("../src/lib/engines/claude.ts");
const { planHold, claudePrice, researchPlan } = await import("../src/lib/credits.ts");
const { autoLevel } = await import("../src/lib/levels.ts");
const { forgetTickers } = await import("../src/lib/server/sec.ts");
const R = await import("../src/lib/research.ts");
const { tokensAtMost } = await import("../src/lib/tokens.ts");

beforeEach(async () => {
  stand.reset();
  forgetTickers();
  Object.assign(process.env, RESEARCH_ENV);
  for (const table of ["source_cache", "rate_limits"]) await sql(`DELETE FROM ${table}`);
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

type ChatEvent = { type: string; delta?: string; message?: string; reason?: string; engine?: string; free?: boolean; items?: { title: string; url: string }[]; error?: string };
let n = 0;
async function chat(who: Awaited<ReturnType<typeof account>>, content: string, body: Record<string, unknown> = {}) {
  const res = await chatRoute.POST(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie },
      body: JSON.stringify({
        projectId: who.projectId,
        replyId: `r${n}${Date.now().toString(36)}`,
        // The turn the route saves with the reply, as the browser sends it.
        userMessage: { id: `u${n++}${Date.now().toString(36)}`, role: "user", content },
        afterId: null,
        engine: "auto",
        level: "auto",
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
  const text = await res.text();
  for (const line of text.split("\n").filter((l) => l.trim())) events.push(JSON.parse(line) as ChatEvent);
  await afterwards();
  return { status: res.status, events, error: "" };
}
const said = (events: ChatEvent[]) => events.filter((e) => e.type === "text").map((e) => e.delta).join("");
const routes = (events: ChatEvent[]) => events.filter((e) => e.type === "route");
const listed = (events: ChatEvent[]) => events.filter((e) => e.type === "sources").at(-1)?.items ?? [];
type ClaudeBody = { system: string; tools?: { name: string }[]; max_tokens: number; messages: { content: unknown }[] };
const claudeSent = () => stand.state.claude.sent as unknown as ClaudeBody[];
type FreeBody = { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[]; stream: boolean };
const freeSent = () => stand.state.free.sent as unknown as FreeBody[];

/** Nothing secret in what the user got, what was saved, or the server's log. */
async function noSecrets(...shown: unknown[]) {
  const saved = await one<{ m: string }>("SELECT group_concat(messages) AS m FROM projects");
  const text = [...logged, saved?.m ?? "", ...shown.map((s) => JSON.stringify(s))].join("\n");
  for (const secret of [PASSWORD, FRED_KEY, BASIC]) assert.equal(text.includes(secret), false, "a secret was shown, saved or logged");
}

test("out of credits, a news question: the free model searches the web, cites what it found, and the header says so", async () => {
  const who = await account("free-news", 0);
  stand.state.free.replies.push({ calls: [{ name: "web_search", args: { query: "news today" } }] }, { text: "The top story today [1], and markets rose [2]." });
  const { status, events } = await chat(who, "what happened in the news today?");
  assert.equal(status, 200);
  const headers = routes(events);
  assert.equal(headers[0].free, true);
  assert.equal(headers[0].engine, "text");
  assert.equal(headers[0].reason, "Research needs credits, so a free model answered without searching the web.");
  assert.equal(headers.at(-1)!.reason, "Research needs credits, so a free model answered with a free web search.");
  assert.match(said(events), /top story today \[1\]/);
  assert.deepEqual(listed(events).map((s) => s.url), ["https://news.example.com/today", "https://news.example.org/markets"]);
  assert.deepEqual(freeSent()[0].tools?.map((t) => t.function.name), ["web_search"]);
  assert.equal(stand.state.seen.find((s) => s.service === "searx")!.headers.authorization, BASIC);
  assert.equal(stand.state.claude.sent.length, 0, "the free lane costs Flash nothing: Claude is never called");
  assert.equal(await balance(who.id), 0);
  await noSecrets(events);
});

test("out of credits with SearXNG down: the reply still comes, says it couldn't search, and never claims a search", async () => {
  const who = await account("free-down", 0);
  stand.state.searx.status = 502;
  stand.state.free.replies.push({ calls: [{ name: "web_search", args: { query: "news today" } }] }, { text: "I couldn't search the web just now." });
  const { status, events } = await chat(who, "what happened in the news today?");
  assert.equal(status, 200);
  assert.equal(events.some((e) => e.type === "error"), false);
  assert.equal(freeSent()[1].messages.find((m) => m.role === "tool")!.content, R.SEARCH_FAILED);
  assert.equal(routes(events).at(-1)!.reason, "Research needs credits, so a free model answered without searching the web.");
  assert.deepEqual(listed(events), []);
  await noSecrets(events);
});

test("everything is hidden while its variables are missing: no web search without SearXNG's, no FRED without its key", async () => {
  delete process.env.SEARXNG_PASSWORD;
  const free = await account("free-hidden", 0);
  const plain = await chat(free, "what happened in the news today?");
  assert.equal(plain.status, 200);
  assert.deepEqual(freeSent().map((b) => [b.stream, b.tools]), [[true, undefined]], "one streamed answer, no tools");
  assert.match(freeSent()[0].messages[0].content, /can't search the web/);

  stand.reset();
  process.env.SEARXNG_URL = "http://searx.test";
  process.env.SEARXNG_PASSWORD = PASSWORD;
  await chat(await account("free-http", 0), "what happened in the news today?");
  assert.equal(freeSent()[0].tools, undefined, "an http SearXNG address is never used");
  assert.equal(stand.state.seen.some((s) => s.service === "searx"), false);

  stand.reset();
  delete process.env.FRED_API_KEY;
  const paid = await account("paid-nofred", 300);
  await chat(paid, "Show me the US unemployment rate trend");
  assert.equal(claudeSent()[0].tools, undefined);
  assert.equal(claudeSent()[0].system.includes(FRED_LINE), false);
});

test("a paid request that doesn't ask for the data holds exactly what it did before: no tools, no lines, the same allowance", async () => {
  const runOnce = async (id: string) => {
    stand.reset();
    await chat(await account(id, 200), "Write a short poem about autumn leaves", { engine: "text", level: "ascend" });
    return claudeSent()[0];
  };
  const withEnv = await runOnce("plain-1");
  for (const name of Object.keys(RESEARCH_ENV)) delete process.env[name];
  const without = await runOnce("plain-2");
  for (const body of [withEnv, without]) {
    assert.equal(body.tools, undefined);
    assert.equal(body.system.includes(SEC_LINE) || body.system.includes(FRED_LINE), false);
  }
  assert.equal(withEnv.max_tokens, without.max_tokens);
  // The hold of a reply without tools, priced as the route prices it: counted input (the stand-in counts
  // 3,000) plus the 3,000 kept for tools, and nothing added for tools it doesn't have.
  const choice = claudeChoice("text", "ascend");
  const scale = claudePrice(choice.model, 6000).output / claudePrice(defaultChoice("text").model, 6000).output;
  assert.equal(withEnv.max_tokens, planHold("text", choice.model, 6000, 200, scale, 0, undefined).maxTokens);
});

test("a paid user asks Apple's revenue: EDGAR's figures come back in the answer, the filing is listed, and the reply is paid from its hold", async () => {
  const who = await account("paid-aapl", 300);
  stand.state.claude.replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "sec_financial_facts", input: { ticker: "AAPL", concepts: ["revenue"], count: 3 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Apple's revenue was $391.0 billion in fiscal 2024, $383.3 billion in 2023 and $394.3 billion in 2022." }], stop: "end_turn" },
  );
  const { status, events } = await chat(who, "What was Apple's revenue for the last 3 years?");
  assert.equal(status, 200);
  const [first, second] = claudeSent();
  assert.deepEqual(first.tools?.map((t) => t.name), ["sec_company_filings", "sec_financial_facts"]);
  assert.ok(first.system.includes(SEC_LINE));
  assert.match(JSON.stringify(second.messages.at(-1)!.content), /391035000000.*383285000000.*394328000000/);
  assert.match(said(events), /\$391\.0 billion/);
  assert.equal(listed(events)[0].title, "SEC EDGAR · Apple Inc. · 10-K · 2024-11-01");
  const spent = 300 - (await balance(who.id));
  assert.ok(spent > 0 && spent < 300, `${spent} credits`);
  for (const s of stand.state.seen.filter((x) => x.service === "sec")) assert.match(String(s.headers["user-agent"]), /^Flash AI \S+@\S+$/);
  await noSecrets(events);
});

test("a paid user asks for the unemployment trend: FRED's values, its link, and its notice under the answer (saved with it)", async () => {
  const who = await account("paid-fred", 300);
  stand.state.claude.replies.push(
    { blocks: [{ type: "tool_use", id: "toolu_f", name: "fred_series", input: { series_id: "UNRATE", count: 24 } }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "US unemployment was 4.3% in September 2026, up from 3.9% two years before." }], stop: "end_turn" },
  );
  const { events } = await chat(who, "Show me the US unemployment rate trend");
  assert.deepEqual(claudeSent()[0].tools?.map((t) => t.name), ["fred_series_search", "fred_series"]);
  assert.ok(said(events).endsWith(R.FRED_NOTE));
  assert.deepEqual(listed(events), [{ title: "FRED® · Unemployment Rate (UNRATE)", url: "https://fred.stlouisfed.org/series/UNRATE" }]);
  const saved = JSON.parse((await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [who.projectId]))!.messages) as { role: string; content: string }[];
  assert.ok(saved.find((m) => m.role === "assistant")!.content.includes(R.FRED_NOTICE));
  await noSecrets(events);
});

test("credits that pay for Research but not for FRED's tools too: Research answers as before, without them, never stepping down or going free", async () => {
  const message = "What is the latest CPI inflation?";
  const choice = claudeChoice("search", autoLevel("search", message).level);
  const scale = claudePrice(choice.model, 6000).output / claudePrice(defaultChoice("search").model, 6000).output;
  const room = tokensAtMost(JSON.stringify([R.FRED_SEARCH, R.FRED_SERIES].map(R.claudeTool)));
  const plain = planHold("search", choice.model, 6000, 0, scale, 0, researchPlan(true, false)).needed;
  const withFred = planHold("search", choice.model, 6000 + room, 0, scale, 0, researchPlan(true, true)).needed;
  assert.ok(withFred > plain, `${plain} < ${withFred}`);
  const who = await account("paid-tight", plain);
  stand.state.claude.replies.push({ blocks: [{ type: "text", text: "CPI rose 2.9% over the year to August." }], stop: "end_turn" });
  const { status, events } = await chat(who, message);
  assert.equal(status, 200);
  assert.equal(routes(events)[0].engine, "search");
  assert.equal(routes(events)[0].free, undefined);
  assert.deepEqual(claudeSent()[0].tools?.map((t) => t.name), ["web_search", "web_fetch"]);
  assert.equal(claudeSent()[0].system.includes(FRED_LINE), false);

  // With the credits for both, Research has FRED's tools too.
  stand.reset();
  const richer = await account("paid-rich", withFred + 50);
  await chat(richer, message);
  assert.deepEqual(claudeSent()[0].tools?.map((t) => t.name), ["web_search", "web_fetch", "fred_series_search", "fred_series"]);
});

test("a user who picked the engine doesn't get the data tools on a paid reply, as with a weather word", async () => {
  const who = await account("picked", 300);
  await chat(who, "What was Apple's revenue for the last 3 years?", { engine: "text", level: "ascend" });
  assert.equal(claudeSent()[0].tools, undefined);
});
