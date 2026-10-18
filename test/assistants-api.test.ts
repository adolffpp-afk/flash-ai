import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/*
 * An owner's assistants on the server (server/assistants.ts), on a libSQL file database with
 * foreign keys off, as Turso runs, and a stand-in for Anthropic's free token count: what a text
 * and a file are counted at, and the ids that tag an assistant's words. Their routes come next.
 */
// The stand-in count: a quarter of the text's bytes, times a weight of the model's own, so each
// level's model counts differently. What was asked is kept; while countDown is set, counting fails.
const asked: { model: string; text: string }[] = [];
let countDown = false;
let weights: Record<string, number> = {};
const countOf = (model: string, text: string) => Math.ceil(Buffer.byteLength(text) / 4) * (weights[model] ?? 1) + 3;
const counter = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as { model: string; messages: { content: string }[] };
    if (!req.url?.includes("count_tokens")) {
      res.writeHead(404);
      return res.end();
    }
    asked.push({ model: body.model, text: body.messages[0].content });
    if (countDown) {
      res.writeHead(529, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: countOf(body.model, body.messages[0].content) }));
  });
});
await new Promise<void>((r) => counter.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "flash-assistants-api-"));
process.env.DATABASE_URL = `file:${join(dir, "api.db")}`;
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(counter.address() as AddressInfo).port}`;
delete process.env.FLASH_APP_URL;
delete process.env.VERCEL_ENV;
after(() => {
  counter.closeAllConnections();
  counter.close();
  rmSync(dir, { recursive: true, force: true });
});

const { db, run, one, mendAssistantIndex } = await import("../src/lib/server/db.ts");
const { createSession } = await import("../src/lib/server/auth.ts");
const { LEVEL_MODELS, countTextTokens } = await import("../src/lib/engines/claude.ts");
const server = await import("../src/lib/server/assistants.ts");
const { EXACT_CHARS, countInstructionTokens, createAssistant, fileTokens } = server;

await db();
await run("PRAGMA foreign_keys = OFF");

// Every level's model, each once, with a weight of its own: the largest isn't the first or last asked.
const MODELS = [...new Set(Object.values(LEVEL_MODELS))];
const WEIGHTS = MODELS.map((_, i) => (i === Math.floor(MODELS.length / 2) ? 3 : 1 + i / 10));
beforeEach(() => {
  asked.length = 0;
  countDown = false;
  weights = Object.fromEntries(MODELS.map((m, i) => [m, WEIGHTS[i]]));
});
const largest = (text: string) => Math.max(...MODELS.map((m) => countOf(m, text)));
const bytes = (text: string) => Buffer.byteLength(text);

let users = 0;
/** A signed-in user. */
async function account() {
  const id = `user${++users}`;
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', 0)", [id, `${id}@example.com`]);
  return { id, cookie: (await createSession(id, true)).split(";")[0] };
}
const count = async (sql: string, args: (string | number)[] = []) => Number((await one<{ n: number }>(sql, args))?.n ?? 0);
// Text of a given length that no other file in the test has.
let texts = 0;
const fresh = (chars: number) => {
  const head = `File ${++texts}. `;
  return (head + "Bread and butter. ".repeat(Math.ceil(chars / 18))).slice(0, chars);
};

test("a text's tokens are Anthropic's free count on every level's model, each asked once, the largest kept; its bytes when counting fails", async () => {
  assert.ok(MODELS.length >= 2, "the levels run on more than one model");
  const text = "Answer in French, kindly, about our breads.";
  assert.equal(await countTextTokens(MODELS[0], text), countOf(MODELS[0], text), "one model's count, as Anthropic gives it");
  assert.deepEqual(asked, [{ model: MODELS[0], text }]);
  asked.length = 0;

  assert.equal(await countInstructionTokens(text), largest(text));
  assert.deepEqual(asked.map((a) => a.model).sort(), [...MODELS].sort(), "every level's model, each once");
  assert.ok(largest(text) > countOf(MODELS[0], text) && largest(text) > countOf(MODELS.at(-1)!, text), "the largest is neither the first nor the last asked");

  asked.length = 0;
  assert.equal(await countInstructionTokens(""), 0, "nothing to count");
  assert.equal(asked.length, 0, "and nothing asked");
  countDown = true;
  const hindi = "हिंदी में जवाब दें";
  assert.equal(await countInstructionTokens(hindi), bytes(hindi), "its UTF-8 bytes, which a count never goes over");
});

test("a file's tokens: counted whole up to 50,000 characters; a longer one by its start, scaled by what grows more, never over its bytes", async () => {
  const short = fresh(EXACT_CHARS);
  assert.deepEqual(await fileTokens(short), { tokens: largest(short), exact: true });
  assert.ok(asked.every((a) => a.text === short));

  // Latin first, then Chinese: three bytes a character, so its bytes grow twice as fast as its characters.
  asked.length = 0;
  const start = fresh(EXACT_CHARS);
  const long = start + "面包".repeat(EXACT_CHARS / 2);
  const est = await fileTokens(long);
  assert.ok(asked.every((a) => a.text === start), "only its first 50,000 characters are sent");
  assert.deepEqual(est, { tokens: Math.min(bytes(long), Math.ceil(largest(start) * (bytes(long) / bytes(start)))), exact: false });
  assert.ok(bytes(long) / bytes(start) > long.length / start.length);

  // A start that counts high is held to the text's bytes.
  weights = Object.fromEntries(MODELS.map((m) => [m, 50]));
  assert.deepEqual(await fileTokens(long), { tokens: bytes(long), exact: false });

  // The start never ends between the two halves of an emoji.
  asked.length = 0;
  const emoji = "a".repeat(EXACT_CHARS - 1) + "🍞" + "b".repeat(10);
  await fileTokens(emoji);
  assert.equal(asked[0].text, "a".repeat(EXACT_CHARS - 1));

  countDown = true;
  assert.deepEqual(await fileTokens(short), { tokens: bytes(short), exact: false }, "its bytes when counting fails");
});

test("no two assistants share the 16 digits that tag their words: the database refuses it, and an id whose 16 are taken is made again", async () => {
  const owner = await account();
  const first = await createAssistant(owner.id, { name: "Bakery helper" });
  const head = first.id.slice(0, 16);
  const ids = [head + "0".repeat(16), "1234567890abcdef".repeat(2)];
  const tried: string[] = [];
  const second = await createAssistant(owner.id, { name: "Second" }, { newId: () => (tried.push(ids[tried.length]), ids[tried.length - 1]) });
  assert.deepEqual(tried, ids, "the first id shared its 16 digits, so another was made");
  assert.equal(second.id, ids[1]);

  // The database itself refuses a second, however it's written.
  await assert.rejects(run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Copy', 0, 0)", [head + "f".repeat(16), owner.id]), /UNIQUE/);
  // An id that keeps colliding is given up on, not used.
  await assert.rejects(createAssistant(owner.id, { name: "Third" }, { newId: () => head + "a".repeat(16) }), (err: InstanceType<typeof server.AssistantError>) => err.refusal.code === "failed");

  // Without the unique index (a database that couldn't make it), the statement that makes one still checks.
  await run("DROP INDEX assistants_tag");
  try {
    const again: string[] = [];
    const third = await createAssistant(owner.id, { name: "Third" }, { newId: () => (again.push("x"), again.length === 1 ? head + "b".repeat(16) : "fedcba0987654321".repeat(2)) });
    assert.equal(third.id, "fedcba0987654321".repeat(2));
    assert.equal(await count("SELECT COUNT(*) AS n FROM assistants WHERE substr(id, 1, 16) = ?", [head]), 1);

    // A database where two already share them: making the index fails, and the rest of the
    // setup still runs (here the trigger, made after it).
    await run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Old twin', 0, 0)", [head + "c".repeat(16), owner.id]);
    await run("DROP TRIGGER assistant_chunks_gone");
    const other = (await import(`../src/lib/server/db.ts?${"again"}`)) as typeof import("../src/lib/server/db.ts");
    (await other.db()).close();
    assert.equal(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'assistant_chunks_gone'"), 1, "setup went on past the index it couldn't make");
    assert.equal(await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'assistants_tag'"), 0);
  } finally {
    await run("DELETE FROM assistants WHERE id = ?", [head + "c".repeat(16)]);
    await run("CREATE UNIQUE INDEX IF NOT EXISTS assistants_tag ON assistants(substr(id, 1, 16))");
    await mendAssistantIndex(await db());
  }
});
