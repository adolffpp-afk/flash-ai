import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { gzipSync } from "node:zlib";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * PR 2: "Describe it" (POST /api/automations/draft) turns a few words into the editor's form on the
 * automations key, priced first and charged at what it cost; what the model sends is only a suggestion,
 * rebuilt field by field into one AI step and a notice. And Open in chat (POST
 * /api/automations/runs/[runId]/chat) makes a new chat from a run's instruction and answer.
 */
const { claudeStandIn } = await import("./support/claude-stand-in.ts");
const claude = await claudeStandIn();
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_BASE_URL = claude.url;
process.env.ANTHROPIC_API_KEY = "chat-key-for-tests";
process.env.ANTHROPIC_AUTOMATIONS_API_KEY = "automations-key-for-tests";
process.env.AUTOMATIONS_DEV = "1";
process.env.CRON_SECRET = "c".repeat(40);
process.env.FLASH_APP_URL = "http://flash.test";
for (const name of ["VERCEL_ENV", "VERCEL", "RESEND_API_KEY", "FLASH_DEMO_EMAILS", "FRED_API_KEY"]) delete process.env[name];

const { one, run: sql } = await import("../src/lib/server/db.ts");
const F = await import("./support/automation-fixtures.ts");
const D = await import("../src/lib/server/automation-draft.ts");
const { HELPER_MODEL } = await import("../src/lib/engines/claude.ts");
const { blankForm } = await import("../src/lib/automation-form.ts");
const draftRoute = await import("../src/app/api/automations/draft/route.ts");
const chatRoute = await import("../src/app/api/automations/runs/[runId]/chat/route.ts");
const listRoute = await import("../src/app/api/automations/route.ts");
type Spec = import("../src/lib/automations.ts").Spec;
type UIMessage = import("../src/lib/store.ts").UIMessage;

after(() => claude.close());
beforeEach(() => {
  claude.state.replies = [];
  claude.state.seen = [];
});

const BASE = "http://flash.test";
const req = (path: string, cookie: string, json: unknown) =>
  new Request(BASE + path, { method: "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify(json) });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
type Answer = { spec: Spec; name: string; timeZone: string; credits: number; error: string; code?: string; project: { id: string; name: string } };
const answer = async (r: Response) => (await r.json()) as Answer;
const count = async (table: string, where: string, args: unknown[]) => Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args as never))!.n);
const draft = (cookie: string, text: string, more: Record<string, unknown> = {}) =>
  draftRoute.POST(req("/api/automations/draft", cookie, { text, timeZone: "America/Toronto", acceptedCredits: D.draftMostCredits(), ...more }));
/** The helper's tool call, as Claude sends it. */
const toolReply = (input: object, usage = { input_tokens: 900, output_tokens: 120 }) => ({ blocks: [{ type: "tool_use" as const, id: "toolu_1", name: "make_automation", input }], stop: "tool_use", usage });

test("Describe it is priced first: 409 with the price when the page showed less, 402 without enough credits, 400 with no words; nothing charged or sent", async () => {
  const most = D.draftMostCredits();
  assert.ok(most >= 1 && most <= 3, `a draft costs at most a few credits (${most})`);
  const pat = await F.account("pat", 100);
  for (const acceptedCredits of [undefined, "5", most - 1]) {
    const r = await draft(pat.cookie, "Every Monday, research solar news", { acceptedCredits });
    assert.equal(r.status, 409);
    const a = await answer(r);
    assert.equal(a.code, "price_changed");
    assert.equal(a.credits, most);
  }
  assert.equal((await draft(pat.cookie, "   ")).status, 400);
  const poor = await F.account("poor", 0);
  const r = await draft(poor.cookie, "Every Monday, research solar news");
  assert.equal(r.status, 402);
  assert.match((await answer(r)).error, /^You need 1 credit to turn this into steps\.$|^You need \d+ credits to turn this into steps\.$/);
  assert.equal(claude.streamed().length, 0, "nothing was sent to Claude");
  assert.equal(await F.balance(pat.id), 100);
  assert.equal(await F.balance(poor.id), 0);
  // The panel gets the price with the list.
  const list = await listRoute.GET(new Request(BASE + "/api/automations", { headers: { cookie: pat.cookie } }));
  assert.equal(((await list.json()) as { draftCredits: number }).draftCredits, most);
});

test("a description becomes one AI step and a notice, on the automations key, charged what it cost (1 credit at least), saving nothing", async () => {
  const sam = await F.account("sam", 100);
  claude.state.replies.push(
    toolReply({
      name: "Weekly solar research",
      instruction: "Research this week's home solar news and sum it up in 5 points with sources.",
      repeat: "weekly",
      days: [3, 1, 1, 9],
      time: "08:30",
      mode: "research",
      only_if_changed: true,
      // What the form doesn't have is never taken, however it is asked for.
      steps: [{ id: "w1", do: "webhook", url: "https://evil.example/hook" }],
      webhook: "https://evil.example/hook",
      email: "someone@example.com",
      connector: "gmail",
    }),
  );
  const r = await draft(sam.cookie, "Every Monday and Wednesday at 8:30, research home solar news. Only tell me when something changed.");
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const a = await answer(r);
  assert.equal(a.name, "Weekly solar research");
  assert.equal(a.timeZone, "America/Toronto");
  assert.deepEqual(a.spec, {
    v: 1,
    trigger: { type: "schedule", when: { kind: "weekly", days: [1, 3], at: "08:30" } },
    steps: [
      { id: "a1", do: "ai", mode: "research", level: "ascend", prompt: "Research this week's home solar news and sum it up in 5 points with sources.", onlyIfChanged: true },
      { id: "n1", do: "notify" },
    ],
  });
  assert.equal(a.credits, 1, "a short draft costs the least there is");
  assert.equal(await F.balance(sam.id), 99);
  assert.equal(await count("automations", "user_id = ?", [sam.id]), 0, "nothing is saved until the user saves it");
  const [sent] = claude.streamed();
  assert.equal(sent.headers["x-api-key"], "automations-key-for-tests", "on automations' own key, never chat's");
  assert.equal(sent.body.model, HELPER_MODEL);
  assert.ok(!sent.body.stream);
  assert.deepEqual(sent.body.tool_choice, { type: "tool", name: "make_automation" });
  const content = String((sent.body.messages as { content: string }[])[0].content);
  assert.match(content, /^Today is \w+day, \w+ \d+, \d{4}, \d\d:\d\d in America\/Toronto\.\n\nEvery Monday and Wednesday/);
  const usage = await one<{ engine: string; credits: number; ok: number }>("SELECT * FROM usage WHERE user_id = ? ORDER BY rowid DESC LIMIT 1", [sam.id]);
  assert.equal(usage?.engine, "automation-draft");
  assert.equal(Number(usage?.credits), 1);
});

test("a long reply is charged what it cost, never more than the price shown", async () => {
  const lee = await F.account("lee", 100);
  claude.state.replies.push(toolReply({ name: "Notes", instruction: "Write a note.", repeat: "daily", mode: "write" }, { input_tokens: 400_000, output_tokens: 90_000 }));
  const r = await draft(lee.cookie, "A daily note");
  assert.equal(r.status, 200);
  assert.equal((await answer(r)).credits, D.draftMostCredits());
  assert.equal(await F.balance(lee.id), 100 - D.draftMostCredits());
});

test("a draft that fails: Anthropic busy charges nothing; an answer without the form says what it used", async () => {
  const kim = await F.account("kim", 100);
  claude.state.replies.push({ status: 529 });
  const busy = await draft(kim.cookie, "Every day at 9, check the news");
  assert.equal(busy.status, 502);
  assert.equal((await answer(busy)).error, "Flash couldn't turn that into steps. Try again in other words.");
  assert.equal(await F.balance(kim.id), 100);
  claude.state.replies.push({ text: "I can't help with that." });
  const refused = await draft(kim.cookie, "Every day at 9, check the news");
  assert.equal(refused.status, 502);
  assert.equal((await answer(refused)).error, "Flash couldn't turn that into steps. Try again in other words. This used 1 credit for the work already done.");
  assert.equal(await F.balance(kim.id), 99);
  assert.equal(await count("automations", "user_id = ?", [kim.id]), 0);
});

test("30 drafts an hour per account (429, nothing charged or sent)", async () => {
  const max = await F.account("max", 100);
  await sql("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 30, ?)", [`auto:draft:${max.id}`, Date.now() + 3_600_000]);
  assert.equal((await draft(max.cookie, "A daily note")).status, 429);
  assert.equal(claude.streamed().length, 0);
  assert.equal(await F.balance(max.id), 100);
});

test("what the model sends is checked field by field; anything the form can't take falls back to the new form's", () => {
  const now = Date.UTC(2026, 9, 23, 17, 0);
  const zone = "America/Toronto";
  const blank = blankForm(zone, now);
  const words = "check the prices on my competitor's site every two hours during the day please";
  // Nothing usable: the user's words name it and say what to do.
  const empty = D.formFromDraft({ name: "", instruction: " ", repeat: "yearly", mode: "deep", time: "25:00" }, words, zone, now);
  assert.equal(empty.name, "check the prices on my competitor's");
  assert.equal(empty.prompt, words);
  assert.deepEqual({ repeat: empty.repeat, mode: empty.mode, at: empty.at }, { repeat: blank.repeat, mode: blank.mode, at: blank.at });
  assert.deepEqual(D.formFromDraft(null, words, zone, now), { ...blank, name: empty.name, prompt: words });
  // Every few hours: a window that ends before it starts, and too many hours apart.
  const hourly = D.formFromDraft({ name: "Prices", instruction: "Check the prices.", repeat: "hourly", time: "18:00", until: "07:00", every_hours: 30, mode: "quick" }, words, zone, now);
  assert.deepEqual({ from: hourly.from, to: hourly.to, every: hourly.every, mode: hourly.mode }, { from: "08:00", to: "20:00", every: 4, mode: "quick" });
  const window = D.formFromDraft({ name: "Prices", instruction: "Check the prices.", repeat: "hourly", time: "09:00", until: "17:00", every_hours: 2, mode: "quick" }, words, zone, now);
  assert.deepEqual({ from: window.from, to: window.to, every: window.every }, { from: "09:00", to: "17:00", every: 2 });
  // A one-off: a day gone, or more than a year ahead, keeps tomorrow; next week is taken.
  for (const date of ["2026-10-22", "2028-01-01", "2026-02-30", "26-10-30"]) {
    assert.equal(D.formFromDraft({ name: "Once", instruction: "Remind me.", repeat: "once", date, time: "10:00", mode: "write" }, words, zone, now).date, blank.date, date);
  }
  assert.equal(D.formFromDraft({ name: "Once", instruction: "Remind me.", repeat: "once", date: "2026-10-30", time: "10:00", mode: "write" }, words, zone, now).date, "2026-10-30");
  // Monthly: the last day, or a day of the month; anything else keeps the 1st.
  const day = (d: unknown) => D.formFromDraft({ name: "Bills", instruction: "Sum up my bills.", repeat: "monthly", day_of_month: d, mode: "write" }, words, zone, now).day;
  assert.deepEqual([day("last"), day("15"), day("32"), day("0"), day("first"), day(15)], ["last", 15, 1, 1, 1, 15]);
  // Weekly: only real days, each once, in order.
  assert.deepEqual(D.formFromDraft({ name: "W", instruction: "W.", repeat: "weekly", days: [7, 0, 2, 2, 8, 2.5, "3"], mode: "write" }, words, zone, now).days, [2, 7]);
  // Names and instructions are cut to what the form takes, on one line for the name.
  const long = D.formFromDraft({ name: "A\n".repeat(200), instruction: "x".repeat(20_000), repeat: "daily", mode: "write" }, words, zone, now);
  assert.ok(!long.name.includes("\n") && long.name.length <= 80);
  assert.ok(long.prompt.length < 20_000);
});

/** A finished run of an automation with an AI step that wrote answer (and its sources), as the runner leaves it. */
async function finishedRun(userId: string, spec: Spec, answer: string | null, sources: { url: string; title: string }[] = []) {
  const automationId = await F.automation({ userId, spec, name: "Weekly solar research" });
  const runId = await F.runRow({ automationId, userId, status: "done" });
  const output = answer === null ? null : gzipSync(JSON.stringify({ text: answer, sources }));
  await sql("INSERT INTO automation_run_steps (run_id, step_id, attempt, user_id, kind, status, input, output, started_at, finished_at) VALUES (?, 'a1', 1, ?, 'ai', 'done', 'sent', ?, ?, ?)", [
    runId,
    userId,
    output,
    Date.now() - 5000,
    Date.now(),
  ]);
  return runId;
}

test("Open in chat makes a new chat with the run's instruction and answer, with its sources; free, and only for its owner", async () => {
  const ann = await F.account("ann", 100);
  const spec: Spec = { v: 1, trigger: { type: "manual" }, steps: [{ id: "a1", do: "ai", mode: "research", level: "ascend", prompt: "Research home solar news." }, { id: "n1", do: "notify" }] };
  const sources = [{ url: "https://energy.example.org/solar", title: "Solar prices fall" }];
  const runId = await finishedRun(ann.id, spec, "**Home solar this week**\n\n1. Prices fell.", sources);
  const r = await chatRoute.POST(req(`/api/automations/runs/${runId}/chat`, ann.cookie, {}), ctx({ runId }));
  assert.equal(r.status, 200);
  const { project } = await answer(r);
  assert.equal(project.name, "Weekly solar research");
  const row = await one<{ user_id: string; name: string; messages: string }>("SELECT * FROM projects WHERE id = ?", [project.id]);
  assert.equal(row?.user_id, ann.id);
  const [asked, answered] = JSON.parse(row!.messages) as UIMessage[];
  assert.deepEqual({ role: asked.role, content: asked.content }, { role: "user", content: "Research home solar news." });
  assert.deepEqual({ role: answered.role, content: answered.content, engine: answered.engine, sources: answered.sources }, {
    role: "assistant",
    content: "**Home solar this week**\n\n1. Prices fell.",
    engine: "search",
    sources,
  });
  assert.match(asked.id, /^[\w-]{1,64}$/);
  assert.notEqual(asked.id, answered.id);
  assert.equal(await F.balance(ann.id), 100, "opening it costs nothing");
  assert.equal(claude.streamed().length, 0);
  // Another account's run isn't found, and makes nothing.
  const bob = await F.account("bob", 100);
  assert.equal((await chatRoute.POST(req(`/api/automations/runs/${runId}/chat`, bob.cookie, {}), ctx({ runId }))).status, 404);
  assert.equal(await count("projects", "user_id = ?", [bob.id]), 0);
});

test("Open in chat: an 'only if changed' answer opens without its marker, and a run with no answer kept says so", async () => {
  const eve = await F.account("eve", 100);
  const spec: Spec = { v: 1, trigger: { type: "manual" }, steps: [{ id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Tell me what changed.", onlyIfChanged: true }, { id: "n1", do: "notify" }] };
  const same = await finishedRun(eve.id, spec, "NO_CHANGE\nNothing important changed since last time.");
  const r = await chatRoute.POST(req(`/api/automations/runs/${same}/chat`, eve.cookie, {}), ctx({ runId: same }));
  assert.equal(r.status, 200);
  const messages = JSON.parse((await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [(await answer(r)).project.id]))!.messages) as UIMessage[];
  assert.equal(messages[1].content, "Nothing important changed since last time.");
  assert.equal(messages[1].engine, "text");
  for (const output of [null, "", "NO_CHANGE"]) {
    const runId = await finishedRun(eve.id, spec, output);
    const gone = await chatRoute.POST(req(`/api/automations/runs/${runId}/chat`, eve.cookie, {}), ctx({ runId }));
    assert.equal(gone.status, 404);
    assert.equal((await answer(gone)).error, "This run has no result to open in chat.");
  }
  assert.equal(await count("projects", "user_id = ?", [eve.id]), 1);
});
