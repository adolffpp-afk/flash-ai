import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A database without FTS5 (Turso might be one): its index can't be made, as simulated here by the
 * database refusing it. Everything else is still made, search falls back to ranking the chunks in
 * JavaScript and finds the same chunks, and deleting still works.
 */
const dir = mkdtempSync(join(tmpdir(), "flash-assistants-"));
process.env.DATABASE_URL = `file:${join(dir, "fallback.db")}`;
after(() => rmSync(dir, { recursive: true, force: true }));

// The local client is the one db.ts makes for file: addresses. It refuses the index as a database
// built without FTS5 does, and runs everything else.
const { Sqlite3Client } = await import("@libsql/client/sqlite3");
const execute = Sqlite3Client.prototype.execute;
const refused: string[] = [];
Sqlite3Client.prototype.execute = function (this: InstanceType<typeof Sqlite3Client>, ...args: Parameters<typeof execute>) {
  const sql = typeof args[0] === "string" ? args[0] : args[0].sql;
  if (/\bUSING fts5\b/i.test(sql)) {
    refused.push(sql);
    return Promise.reject(new Error("SQLITE_ERROR: no such module: fts5"));
  }
  return execute.apply(this, args);
};

const { db, run, one, all } = await import("../src/lib/server/db.ts");
const { indexFile, passagesFor, searchChunks, searchMode, removeFileRows } = await import("../src/lib/server/assistant-search.ts");
const { queryTerms, rankChunks, tagOf, tagged } = await import("../src/lib/assistant-chunks.ts");
const { STORE_FACTOR } = await import("../src/lib/assistants.ts");
const { DELIVERY, GLUTEN, REFUNDS, TOP_PAGES, filler, pdf } = await import("./support/assistant-files.ts");

const BAKERY = "00000001".repeat(4);
async function file(id: string, name: string, text: string, tokens = Math.ceil(Buffer.byteLength(text) / 4)) {
  await run(
    "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, exact, hash, created_at) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, 1, ?, 0)",
    [id, BAKERY, name, text.length, Buffer.byteLength(text), STORE_FACTOR * Buffer.byteLength(text), tokens, id],
  );
  return indexFile(BAKERY, id, text, tokens);
}

test("a failing FTS statement never stops init()", async () => {
  await db();
  assert.equal(refused.length, 1, "the index was asked for, and refused");
  const names = (await all<{ name: string }>("SELECT name FROM sqlite_master")).map((r) => r.name);
  for (const name of ["users", "projects", "report_actions", "assistants", "assistant_files", "assistant_chunks", "assistant_visitors", "projects_assistant", "site_messages_contact"]) {
    assert.ok(names.includes(name), `${name} was made`);
  }
  assert.ok((await all<{ name: string }>("PRAGMA table_info(projects)")).some((c) => c.name === "assistant_id"));
  assert.ok(!names.includes("assistant_chunks_fts"));
  // A trigger deleting from an index that isn't there would make every delete of a chunk fail.
  assert.ok(!names.includes("assistant_chunks_gone"), "no trigger without the index");
  assert.equal(await searchMode(true), "fallback");
  await run("PRAGMA foreign_keys = OFF");
});

test("without the index, chunks are ranked in JavaScript and find what the index finds", async () => {
  await run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, 'owner', 'Bakery helper', 0, 0)", [BAKERY]);
  const stored = await file("handbook", "Handbook.pdf", pdf(14, { 3: REFUNDS, 7: DELIVERY, 11: GLUTEN }));
  assert.deepEqual(stored.indexed, false);
  assert.ok(await one("SELECT 1 FROM settings WHERE key = 'assistant_unindexed'"), "it's marked that chunks exist outside any index");
  const read = await passagesFor({ id: BAKERY }, "How do refunds work?", "", { named: true });
  assert.equal(read.mode, "search");
  assert.match(read.passages.map((p) => p.text).join("\n"), /paid within 14 days/);
  assert.ok(read.passages.every((p) => p.title.startsWith("Handbook.pdf, page 3")));
  // The same pages as with the index (see assistant-search.test.ts), from the same handbook.
  const rows = await all<{ id: number; body: string }>("SELECT id, body FROM assistant_chunks WHERE assistant_id = ? ORDER BY id", [BAKERY]);
  for (const [message, page] of TOP_PAGES) {
    const [top] = await searchChunks(BAKERY, queryTerms(message));
    assert.equal(top.label, page, message);
    assert.equal(top.id, rankChunks(rows, queryTerms(message))[0].id);
  }
  assert.deepEqual(await passagesFor({ id: BAKERY }, "thanks, see you soon"), { mode: "none", passages: [], nomatch: true });
  assert.equal((await passagesFor({ id: BAKERY }, "", "", { readStart: true })).mode, "start");
});

test("without the index, deleting a file still deletes all of it", async () => {
  await file("extra", "extra.txt", `${filler(5000, 3)}\n\nPlatypus postcards.`);
  assert.equal((await passagesFor({ id: BAKERY }, "platypus")).passages.length, 1);
  await (await db()).batch(removeFileRows("owner", BAKERY, "extra"), "write");
  assert.equal(await one("SELECT 1 FROM assistant_chunks WHERE file_id = 'extra'"), null);
  assert.equal(await one("SELECT 1 FROM assistant_files WHERE id = 'extra'"), null);
  assert.deepEqual((await passagesFor({ id: BAKERY }, "platypus")).passages, []);
});

test("/admin says the slower fallback is in use, with no storage factor until there is enough to measure", async () => {
  const { adminStats } = await import("../src/lib/server/admin-stats.ts");
  assert.deepEqual(JSON.parse(JSON.stringify(await adminStats(30))).assistantSearch, { mode: "fallback", factor: null });
});

test("once the database can make the index, chunks stored without it keep search on the fallback", async () => {
  Sqlite3Client.prototype.execute = execute;
  // As init() would on the next start.
  await run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS assistant_chunks_fts USING fts5(seg, content='', contentless_delete=1, tokenize=\"unicode61 remove_diacritics 2 categories 'L* N* Co M*'\")",
  );
  await run("CREATE TRIGGER IF NOT EXISTS assistant_chunks_gone AFTER DELETE ON assistant_chunks BEGIN DELETE FROM assistant_chunks_fts WHERE rowid = old.id; END");
  assert.equal(await searchMode(), "fallback", "this server keeps its answer for a while");
  assert.equal(await searchMode(true), "fallback", "and the database says the old chunks aren't in the index");
  // Searching the index would miss the handbook; the fallback still finds it.
  assert.match((await passagesFor({ id: BAKERY }, "How do refunds work?")).passages.map((p) => p.text).join(""), /paid within 14 days/);
  // New files go into the index as well, ready for when it's rebuilt.
  const added = await file("new", "new.txt", `${filler(5000, 4)}\n\nEchidna egg cups.`);
  assert.equal(added.indexed, true);
  assert.ok(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks_fts"))?.n) >= added.chunks);
  assert.equal((await passagesFor({ id: BAKERY }, "echidna")).passages.length, 1);
});

test("once the old chunks are in the index too, search uses it, after the 10 minutes a server keeps its answer", async (t) => {
  // Every chunk stored before the index existed, put in it, as a rebuild would.
  const missing = await all<{ id: number; body: string }>(
    "SELECT id, body FROM assistant_chunks WHERE assistant_id = ? AND id NOT IN (SELECT rowid FROM assistant_chunks_fts)",
    [BAKERY],
  );
  assert.ok(missing.length > 0);
  for (const c of missing) await run("INSERT INTO assistant_chunks_fts (rowid, seg) VALUES (?, ?)", [c.id, tagged(tagOf(BAKERY), c.body)]);
  await run("DELETE FROM settings WHERE key = 'assistant_unindexed'");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  assert.equal(await searchMode(), "fallback", "kept for 10 minutes");
  t.mock.timers.tick(9 * 60_000);
  assert.equal(await searchMode(), "fallback");
  t.mock.timers.tick(2 * 60_000);
  assert.equal(await searchMode(), "index", "then asked again");
  const read = await passagesFor({ id: BAKERY }, "How do refunds work?", "", { named: true });
  assert.ok(read.passages.length > 0 && read.passages.every((p) => p.title.startsWith("Handbook.pdf, page 3")));
});

test("/admin asks the database afresh, not this server's kept answer", async () => {
  // Chunks stored outside the index again, after this server last asked.
  await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('assistant_unindexed', '1')");
  assert.equal(await searchMode(), "index", "this server's kept answer");
  const { adminStats } = await import("../src/lib/server/admin-stats.ts");
  assert.equal(JSON.parse(JSON.stringify(await adminStats(30))).assistantSearch.mode, "fallback");
});
