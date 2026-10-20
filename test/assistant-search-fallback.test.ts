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
const { catchUpIndex, indexFile, passagesFor, purgeIndex, searchChunks, searchMode, removeFileRows } = await import("../src/lib/server/assistant-search.ts");
const { queryTerms, rankChunks, words } = await import("../src/lib/assistant-chunks.ts");
const { STORE_FACTOR } = await import("../src/lib/assistants.ts");
const { DELIVERY, GLUTEN, REFUNDS, TOP_PAGES, filler, pdf } = await import("./support/assistant-files.ts");
/** Another copy of the search module, as another server has, with its own memory of what it found. */
const anotherServer = (name: string) => import(`../src/lib/server/assistant-search.ts?${name}`) as Promise<typeof import("../src/lib/server/assistant-search.ts")>;

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
  assert.deepEqual(await catchUpIndex(), { state: "none" }, "no index to catch up");
  assert.deepEqual(await all("SELECT key FROM settings WHERE key LIKE 'assistant%'"), []);
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
  await purgeIndex();
  assert.equal(await one("SELECT 1 FROM assistant_chunks WHERE file_id = 'extra'"), null);
  assert.equal(await one("SELECT 1 FROM assistant_files WHERE id = 'extra'"), null);
  assert.deepEqual((await passagesFor({ id: BAKERY }, "platypus")).passages, []);
});

test("without the index, every batch of an upload marks anew that chunks exist outside it", async () => {
  const client = await db();
  const batch = client.batch;
  const marks: unknown[] = [];
  client.batch = (async (...args: Parameters<typeof batch>) => {
    for (const st of args[0]) if (typeof st === "object" && !Array.isArray(st) && /INTO settings/.test(st.sql) && st.args && (st.args as unknown[])[0] === "assistant_unindexed") marks.push((st.args as unknown[])[1]);
    return batch.apply(client, args);
  }) as typeof batch;
  try {
    const big = await file("big", "big.txt", filler(260 * 1200, 11));
    const batches = Math.ceil(big.chunks / 100);
    assert.ok(batches >= 3, `${big.chunks} chunks: ${batches} batches`);
    assert.equal(marks.length, batches, "one mark a batch");
    assert.equal(new Set(marks).size, batches, "each its own");
    assert.equal((await one<{ value: string }>("SELECT value FROM settings WHERE key = 'assistant_unindexed'"))?.value, marks.at(-1));
  } finally {
    client.batch = batch;
  }
  await client.batch(removeFileRows("owner", BAKERY, "big"), "write");
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

test("catchUpIndex puts the chunks stored without the index into it, a bounded step at a time, and then search uses it: here at once, elsewhere after 10 minutes", async (t) => {
  const index = async () => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks_fts"))?.n);
  const missing = async () =>
    (await all<{ id: number }>("SELECT id FROM assistant_chunks c WHERE NOT EXISTS (SELECT 1 FROM assistant_chunks_fts f WHERE f.rowid = c.id) ORDER BY id")).map((r) => Number(r.id));
  const settings = async () => (await all<{ key: string }>("SELECT key FROM settings WHERE key LIKE 'assistant\\_%' ESCAPE '\\' AND key != 'assistant_index_purged' ORDER BY key")).map((r) => r.key);
  // This server has asked, and keeps its answer; another server (its own copy of the module) does the work.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  assert.equal(await searchMode(true), "fallback");
  const other = await anotherServer("another-server");
  const before = await missing();
  assert.ok(before.length > 12, `the handbook's ${before.length} chunks aren't in the index`);
  const indexed = await index();

  // One step: at most 5 chunks (as told here) of the next 8 ids, with how far it came, in one batch.
  const step = { budgetMs: 0, span: 8, chunks: 5 };
  const first = await other.catchUpIndex(step);
  assert.equal(first.state, "behind");
  assert.equal((await index()) - indexed, 5);
  assert.deepEqual(await missing(), before.slice(5));
  assert.ok(first.done! >= before[4] && first.done! < before[5]);
  assert.equal(await searchMode(true), "fallback", "a half-made index is never searched");
  assert.deepEqual(await settings(), ["assistant_index_catch_up", "assistant_unindexed"]);

  // A chunk not reached yet is deleted (with its file's other chunks); a file is stored without the
  // index meanwhile, as an upload that began before the index existed stores it: it gets a new mark.
  const gone = before.at(-1)!;
  await run("INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, exact, hash, created_at) VALUES ('late', ?, 'late.txt', 'text', 30, 30, 90, 8, 1, 'late', 0)", [BAKERY]);
  await run("INSERT INTO assistant_chunks (assistant_id, file_id, seq, label, chars, tokens, body) VALUES (?, 'late', 0, 'part 1', 30, 8, 'Quokka quiche on Thursdays.')", [BAKERY]);
  await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('assistant_unindexed', 'a later upload')");
  await run("DELETE FROM assistant_chunks WHERE id = ?", [gone]);
  const late = Number((await one<{ id: number }>("SELECT id FROM assistant_chunks WHERE file_id = 'late'"))?.id);
  assert.ok(late > first.of!, "stored after the catch-up began, so beyond where it was to stop");

  // The next step's chunks are read; then, before it writes, one of them is deleted, and a third
  // server takes the same step from the same place.
  const third = await anotherServer("a-third-server");
  const client = await db();
  const batch = client.batch;
  let raced = 0;
  let nested = false;
  client.batch = (async (...args: Parameters<typeof batch>) => {
    const ids = args[0].flatMap((st) => (typeof st === "object" && !Array.isArray(st) && /^INSERT INTO assistant_chunks_fts \(rowid, seg\)/.test(st.sql) ? [(st.args as number[])[0]] : []));
    if (ids.length && !raced && !nested) {
      raced = ids[1];
      await run("DELETE FROM assistant_chunks WHERE id = ?", [raced]);
      nested = true;
      await third.catchUpIndex(step);
      nested = false;
    }
    return batch.apply(client, args);
  }) as typeof batch;
  let second: Awaited<ReturnType<typeof other.catchUpIndex>>;
  try {
    second = await other.catchUpIndex(step);
  } finally {
    client.batch = batch;
  }
  assert.ok(raced > 0);
  assert.deepEqual(await all("SELECT rowid FROM assistant_chunks_fts WHERE rowid = ?", [raced]), [], "a chunk deleted meanwhile gets no index row");
  assert.equal(await index(), Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks c WHERE EXISTS (SELECT 1 FROM assistant_chunks_fts f WHERE f.rowid = c.id)"))?.n), "and none gets two");

  let steps = 2;
  for (let r = second; r.state === "behind"; steps++) {
    assert.ok(steps < 100);
    r = await other.catchUpIndex(step);
  }
  assert.ok(steps >= Math.ceil(before.length / 5), `${steps} steps`);
  assert.deepEqual(await missing(), [], "every chunk is in the index, the late one too");
  const chunks = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks"))?.n);
  assert.equal(await index(), chunks, "once each: no chunk twice, and nothing for the deleted ones");
  assert.deepEqual(await all("SELECT rowid FROM assistant_chunks_fts WHERE rowid IN (?, ?)", [gone, raced]), []);
  // Every word of every chunk is in the index once: a chunk put in twice would count its words twice.
  await run("CREATE VIRTUAL TABLE IF NOT EXISTS temp.caught_up USING fts5vocab(main, assistant_chunks_fts, 'row')");
  const instances = Number((await one<{ n: number }>("SELECT SUM(cnt) AS n FROM temp.caught_up"))?.n);
  const bodies = await all<{ body: string }>("SELECT body FROM assistant_chunks");
  assert.equal(instances, bodies.reduce((sum, c) => sum + words(c.body).length, 0), "each chunk's words once");
  assert.deepEqual(await settings(), [], "nothing left behind");
  assert.equal(await other.searchMode(), "index", "the server that finished uses the index at once");
  assert.deepEqual(await other.catchUpIndex(), { state: "current" });

  assert.equal(await searchMode(), "fallback", "this one keeps its answer for 10 minutes");
  t.mock.timers.tick(9 * 60_000);
  assert.equal(await searchMode(), "fallback");
  t.mock.timers.tick(2 * 60_000);
  assert.equal(await searchMode(), "index", "then asks again");
  // The index finds what the fallback found, the late file's chunk too.
  const read = await passagesFor({ id: BAKERY }, "How do refunds work?", "", { named: true });
  assert.ok(read.passages.length > 0 && read.passages.every((p) => p.title.startsWith("Handbook.pdf, page 3")));
  const rows = await all<{ id: number; body: string }>("SELECT id, body FROM assistant_chunks WHERE assistant_id = ? ORDER BY id", [BAKERY]);
  for (const [message, page] of TOP_PAGES) {
    const [top] = await searchChunks(BAKERY, queryTerms(message), "index");
    assert.equal(top.label, page, message);
    assert.equal(top.id, rankChunks(rows, queryTerms(message))[0].id);
  }
  assert.deepEqual((await searchChunks(BAKERY, queryTerms("quokka quiche"), "index")).map((c) => Number(c.id)), [late]);
  await (await db()).batch(removeFileRows("owner", BAKERY, "late"), "write");
});

test("/admin asks the database afresh, not this server's kept answer", async () => {
  // Chunks stored outside the index again, after this server last asked.
  await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('assistant_unindexed', '1')");
  assert.equal(await searchMode(), "index", "this server's kept answer");
  const { adminStats } = await import("../src/lib/server/admin-stats.ts");
  assert.equal(JSON.parse(JSON.stringify(await adminStats(30))).assistantSearch.mode, "fallback");
});
