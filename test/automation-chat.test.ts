import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { register } from "node:module";
import { startStandIns } from "./support/research-stand-ins.ts";

/*
 * Automations in chat (plan §1.1, PR 2b): a message that asks for something again and again ("every
 * Monday, sum up…") tells Write and Research that Flash can do it on a schedule, only where Automations
 * is open to the user, and marks the answer so the page shows Review automation under it. Claude and
 * the free model are stand-ins (see support/research-stand-ins.ts).
 */
register("./support/route-hooks.mjs", import.meta.url);

const stand = await startStandIns();
stand.install();
after(() => stand.close());

const SECRET = "x".repeat(40);
process.env.DATABASE_URL = ":memory:";
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `${stand.origin}/anthropic`;
process.env.GROQ_API_KEY = "groq-test";
process.env.GROQ_BASE_URL = `${stand.origin}/groq`;
process.env.AUTOMATIONS_DEV = "1";
process.env.CRON_SECRET = SECRET;
process.env.FLASH_APP_URL = "http://flash.test";
process.env.FLASH_ADMIN_EMAILS = "boss@example.com, chief@example.com, freeboss@example.com, picker@example.com, unset@example.com";
for (const name of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_BASE_URL", "VERCEL", "VERCEL_ENV", "RESEND_API_KEY", "CONNECTOR_KEYS", "SEARXNG_URL", "FRED_API_KEY"]) {
  delete process.env[name];
}
for (const level of ["log", "error", "warn", "info"] as const) console[level] = () => {};

const { afterwards } = await import("./support/next-server.mjs");
const { run: sql, one } = await import("../src/lib/server/db.ts");
const chatRoute = await import("../src/app/api/chat/route.ts");
const { AUTOMATION_LINE } = await import("../src/lib/engines/claude.ts");

beforeEach(() => {
  stand.reset();
  process.env.CRON_SECRET = SECRET;
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

let n = 0;
// The stream of the latest chat request.
let streamed: { type: string }[] = [];
/** A chat request as the page sends it, read to its end. */
async function chat(who: Awaited<ReturnType<typeof account>>, content: string, body: Record<string, unknown> = {}) {
  const res = await chatRoute.POST(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: who.cookie },
      body: JSON.stringify({
        projectId: who.projectId,
        replyId: `r${n}${Date.now().toString(36)}`,
        userMessage: { id: `u${n++}${Date.now().toString(36)}`, role: "user", content },
        afterId: null,
        engine: "auto",
        level: "auto",
        messages: [{ role: "user", content }],
        ...body,
      }),
    }),
  );
  streamed = (await res.text())
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as { type: string });
  await afterwards();
  return res.status;
}
const claudeSystems = () => (stand.state.claude.sent as unknown as { system: string }[]).map((b) => b.system);
// The system prompts the hold counted (count_tokens), as the replies send them.
const countedSystems = () =>
  stand.state.seen.filter((s) => s.service === "anthropic" && s.path.endsWith("/count_tokens")).map((s) => (typeof s.body.system === "string" ? s.body.system : JSON.stringify(s.body.system)));
// The page was told to offer Review automation under the answer.
const marked = () => streamed.some((e) => e.type === "automation");
const savedReply = async (who: Awaited<ReturnType<typeof account>>) =>
  (JSON.parse((await one<{ messages: string }>("SELECT messages FROM projects WHERE id = ?", [who.projectId]))!.messages) as { role: string; automation?: boolean }[])
    .filter((m) => m.role === "assistant")
    .at(-1);
const freeSystems = () => (stand.state.free.sent as unknown as { messages: { role: string; content: string }[] }[]).map((b) => b.messages[0].content);

const EVERY_MONDAY = "Every Monday morning, give me a short summary of the news about electric cars";

test("an admin asks for something every Monday: the answer (Research, for news) is told Flash can do it on a schedule, and the hold counts it; a plain question isn't", async () => {
  const boss = await account("boss", 500);
  assert.equal(await chat(boss, EVERY_MONDAY), 200);
  assert.equal(claudeSystems().length, 1);
  assert.ok(claudeSystems()[0].includes(AUTOMATION_LINE));
  assert.ok(countedSystems().length > 0, "the reply was counted before it was held");
  assert.ok(
    countedSystems().every((s) => s.includes(AUTOMATION_LINE)),
    "what was held for read the line too",
  );
  assert.ok(marked(), "the page offers Review automation");
  assert.equal((await savedReply(boss))?.automation, true, "and still does once the chat is opened again");
  stand.reset();
  await chat(boss, "Give me a short summary of the news about electric cars");
  assert.equal(claudeSystems()[0].includes(AUTOMATION_LINE), false);
  assert.equal(marked(), false);
  assert.equal((await savedReply(boss))?.automation, undefined);
});

test("Research (picked) gets the line, Code doesn't, and someone Automations isn't open to never does", async () => {
  const picker = await account("picker", 500);
  await chat(picker, EVERY_MONDAY, { engine: "search", level: "ascend" });
  assert.ok(claudeSystems().at(-1)!.includes(AUTOMATION_LINE));
  assert.ok(marked());
  stand.reset();
  await chat(picker, "Every day at 9, check my website's uptime and write a script for it", { engine: "code", level: "ascend" });
  assert.ok(claudeSystems().length > 0);
  assert.equal(claudeSystems().some((s) => s.includes(AUTOMATION_LINE)), false);
  assert.equal(marked(), false, "Code");
  stand.reset();
  const someone = await account("someone", 500);
  await chat(someone, EVERY_MONDAY);
  assert.equal(claudeSystems()[0].includes(AUTOMATION_LINE), false, "not an admin, and Automations isn't open to everyone");
  assert.equal(marked(), false, "not an admin");
});

test("a message with a file, and Code, Translate and Docs, never get the line", async () => {
  const chief = await account("chief", 500);
  const notes = { name: "brands.txt", mediaType: "text/plain", data: Buffer.from("Tesla, BYD, Rivian").toString("base64") };
  assert.equal(await chat(chief, EVERY_MONDAY, { messages: [{ role: "user", content: EVERY_MONDAY, attachment: notes }] }), 200);
  assert.ok(claudeSystems().length > 0);
  assert.equal(claudeSystems().some((s) => s.includes(AUTOMATION_LINE)), false, "with a file");
  assert.equal(marked(), false, "with a file");
  for (const engine of ["code", "translate", "docs"]) {
    stand.reset();
    assert.equal(await chat(chief, EVERY_MONDAY, { engine, level: "ascend" }), 200, engine);
    assert.ok(claudeSystems().length > 0, engine);
    assert.equal(claudeSystems().some((s) => s.includes(AUTOMATION_LINE)), false, engine);
    assert.equal(marked(), false, engine);
  }
});

test("out of credits, the free model is told too; without CRON_SECRET (Automations can't run) nobody is", async () => {
  const free = await account("freeboss", 0);
  await chat(free, EVERY_MONDAY);
  assert.equal(stand.state.claude.sent.length, 0, "the free lane never calls Claude");
  assert.ok(freeSystems()[0].includes(AUTOMATION_LINE));
  assert.ok(marked(), "the free model's answer");
  stand.reset();
  delete process.env.CRON_SECRET;
  const unset = await account("unset", 500);
  await chat(unset, EVERY_MONDAY);
  assert.equal(claudeSystems()[0].includes(AUTOMATION_LINE), false);
  assert.equal(marked(), false, "without CRON_SECRET");
});
