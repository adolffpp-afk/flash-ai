import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * What a message reads from an assistant's files, on a libSQL file database with foreign keys off,
 * as Turso runs: only that assistant's chunks, all of them when they fit, the best matches
 * otherwise, never more than the cap, nothing when nothing matches, and nothing left behind when a
 * file goes. The same search without FTS5 is in assistant-search-fallback.test.ts.
 */
const dir = mkdtempSync(join(tmpdir(), "flash-assistants-"));
process.env.DATABASE_URL = `file:${join(dir, "search.db")}`;
after(() => rmSync(dir, { recursive: true, force: true }));

const { db, run, one, all } = await import("../src/lib/server/db.ts");
const search = await import("../src/lib/server/assistant-search.ts");
const { indexFile, passagesFor, searchChunks, searchMode, removeFileRows, storageFactor } = search;
const { chunkText, queryTerms, rankChunks, tagOf, tagged } = await import("../src/lib/assistant-chunks.ts");
const { PASSAGE_TOKENS, MAX_PASSAGES, STORE_FACTOR } = await import("../src/lib/assistants.ts");
const { DELIVERY, GLUTEN, REFUNDS, TOP_PAGES, filler, pdf, sheet, pagesUsed, seeded } = await import("./support/assistant-files.ts");

await db();
await run("PRAGMA foreign_keys = OFF");

const bytes = (s: string) => Buffer.byteLength(s);
let made = 0;
/** An assistant of the user's, with a fresh 32-hex id. */
async function assistant(userId: string, name = "Bakery helper"): Promise<string> {
  const id = (++made).toString(16).padStart(8, "0").repeat(4);
  await run("INSERT INTO assistants (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)", [id, userId, name]);
  return id;
}
let files = 0;
/** A file of the assistant's, stored and indexed as an upload will. tokens defaults to a quarter of its bytes. */
async function file(assistantId: string, name: string, text: string, o: { tokens?: number; exact?: number } = {}): Promise<string> {
  const id = `file${++files}`;
  const tokens = o.tokens ?? Math.ceil(bytes(text) / 4);
  await run(
    "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, exact, hash, created_at) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?)",
    [id, assistantId, name, text.length, bytes(text), STORE_FACTOR * bytes(text), tokens, o.exact ?? 1, id, files],
  );
  await indexFile(assistantId, id, text, tokens);
  return id;
}
const chunksOf = (fileId: string) => all<{ id: number; seq: number; body: string; tokens: number }>("SELECT id, seq, body, tokens FROM assistant_chunks WHERE file_id = ? ORDER BY seq", [fileId]);
const indexRows = async () => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks_fts"))?.n);
const matching = async (assistantId: string, word: string) =>
  (await all<{ rowid: number }>("SELECT rowid FROM assistant_chunks_fts WHERE seg MATCH ?", [`"${tagOf(assistantId)}${word}"`])).map((r) => Number(r.rowid));

// The bakery's handbook (searched: far over 6,000 tokens) and another user's assistant with the same words.
const bakery = await assistant("owner");
const handbook = await file(bakery, "Handbook.pdf", pdf(14, { 3: REFUNDS, 7: DELIVERY, 11: GLUTEN }));
const prices = await file(bakery, "Prices.xlsx", sheet("Prices", [["item", "price"], ...Array.from({ length: 120 }, (_, i) => [`loaf ${i}`, `${(i % 9) + 2}.50`])]));
const notes = await file(bakery, "notes.txt", `${filler(3000, 7)}\n\nWombat-shaped cookies are a Saturday special.\n\n${filler(3000, 8)}`);
const other = await assistant("someone-else", "Their shop");
const theirs = await file(other, "Theirs.pdf", pdf(10, { 2: REFUNDS, 5: DELIVERY, 8: "Zebrafinch biscuits only on request." }, 2));

test("the database makes the full-text index and the trigger that keeps it clean", async () => {
  assert.equal(await searchMode(true), "index");
  const made = await all<{ name: string; type: string }>("SELECT name, type FROM sqlite_master WHERE name IN ('assistant_chunks_fts', 'assistant_chunks_gone', 'projects_assistant')");
  assert.deepEqual(made.map((r) => r.name).sort(), ["assistant_chunks_fts", "assistant_chunks_gone", "projects_assistant"]);
  assert.equal(Number((await one<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys), 0, "foreign keys off, as on Turso");
  // The index keeps a Thai or Hindi word whole, so it's found as typed, and finds "café" for "cafe".
  const words = await assistant("owner", "Words");
  const thai = await file(words, "thai.txt", `ราคาสินค้ารวมภาษีแล้ว ${filler(200, 3)}`);
  await file(words, "hindi.txt", `नमस्ते दुनिया ${filler(200, 4)} Café crème.`);
  assert.deepEqual(await matching(words, "สินค้า"), (await chunksOf(thai)).map((c) => c.id));
  assert.equal((await matching(words, "cafe")).length, 1);
  // Every word in the index carries an assistant's tag: none, not even a piece of a Thai or Hindi
  // word, is left in a list every assistant's search would read.
  await run("CREATE VIRTUAL TABLE IF NOT EXISTS temp.index_words USING fts5vocab(main, assistant_chunks_fts, 'row')");
  const untagged = await all<{ term: string }>("SELECT term FROM temp.index_words WHERE term NOT GLOB ?", [`a${"[0-9a-f]".repeat(16)}x?*`]);
  assert.deepEqual(untagged, []);
  assert.ok(Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM temp.index_words WHERE term GLOB ?", [`${tagOf(words)}*`]))?.n) > 10);
  const read = await passagesFor({ id: words }, "สินค้า", "", { readStart: false });
  assert.equal(read.mode, "whole", "two small files, read whole");
});

test("only the asking assistant's chunks come back, even with a planted stray index row", async () => {
  const mine = new Set([handbook, prices, notes]);
  const read = await passagesFor({ id: bakery }, "How do refunds work?");
  assert.equal(read.mode, "search");
  assert.ok(read.passages.length > 0);
  assert.ok(read.passages.every((p) => mine.has(p.fileId)), "only the bakery's files");
  assert.match(read.passages.map((p) => p.text).join("\n"), /paid within 14 days/);
  const theirRead = await passagesFor({ id: other }, "How do refunds work?");
  assert.ok(theirRead.passages.length > 0 && theirRead.passages.every((p) => p.fileId === theirs));

  // Index rows in the bakery's words left behind: one whose id now belongs to the other assistant's
  // chunk, and one whose chunk is gone.
  await run("INSERT INTO assistant_chunks (assistant_id, file_id, seq, chars, tokens, body) VALUES (?, ?, 99, 30, 8, 'Their zebrafinch biscuit recipe.')", [other, theirs]);
  const their = (await one<{ id: number }>("SELECT MAX(id) AS id FROM assistant_chunks"))!.id;
  await run("INSERT INTO assistant_chunks_fts (rowid, seg) VALUES (?, ?), (?, ?)", [their, tagged(tagOf(bakery), "zebrafinch biscuits"), 10 ** 9, tagged(tagOf(bakery), "zebrafinch")]);
  assert.deepEqual((await matching(bakery, "zebrafinch")).sort((x, y) => x - y), [Number(their), 10 ** 9], "the stray rows are in the index");
  const stray = await passagesFor({ id: bakery }, "Do you make zebrafinch biscuits?");
  assert.deepEqual(stray.passages, [], "and finds nothing of theirs");
  assert.equal(stray.nomatch, true);
  assert.ok((await passagesFor({ id: other }, "zebrafinch biscuits")).passages.every((p) => p.fileId === theirs));
  // Pasting the other assistant's tag doesn't reach its words either.
  assert.deepEqual((await passagesFor({ id: bakery }, `${tagOf(other)}zebrafinch`)).passages, []);
  await run("DELETE FROM assistant_chunks WHERE id = ?", [their]);
  await run("DELETE FROM assistant_chunks_fts WHERE rowid = ?", [10 ** 9]);
  assert.deepEqual(await matching(bakery, "zebrafinch"), []);
});

test("files that fit are read whole, in order, on every message, without a search", async () => {
  const small = await assistant("owner", "Small");
  const a = filler(1800, 11);
  const b = `${filler(1500, 12)}\n\nOpening hours: 7 to 19.`;
  await file(small, "Menu.txt", a, { tokens: 2500 });
  await file(small, "Hours.txt", b, { tokens: 3500 });
  for (const message of ["thanks!", "", "What are the opening hours?"]) {
    const read = await passagesFor({ id: small }, message);
    assert.equal(read.mode, "whole", message);
    assert.deepEqual(read.passages.map((p) => [p.title, p.text]), [["File 1", a], ["File 2", b]]);
  }
  assert.deepEqual((await passagesFor({ id: small }, "", "", { named: true })).passages.map((p) => p.title), ["Menu.txt", "Hours.txt"]);
  // One token more, or a count that was only an estimate, and the files are searched instead.
  await file(small, "Extra.txt", "One more line.", { tokens: 1 });
  assert.equal((await passagesFor({ id: small }, "thanks!")).mode, "none");
  const estimated = await assistant("owner", "Estimated");
  await file(estimated, "a.txt", a, { tokens: 100, exact: 0 });
  assert.equal((await passagesFor({ id: estimated }, "thanks!")).mode, "none");
  // A free model's smaller room: whole files that don't fit it are searched, and passages kept to it.
  const roomy = await assistant("owner", "Roomy");
  await file(roomy, "Menu.txt", filler(5000, 13), { tokens: 1500 });
  await file(roomy, "Hours.txt", `${filler(2500, 14)}\n\nOpening hours: 7 to 19.\n\n${filler(2500, 15)}`, { tokens: 1500 });
  assert.equal((await passagesFor({ id: roomy }, "opening hours")).mode, "whole");
  const fits = await passagesFor({ id: roomy }, "opening hours", "", { maxChars: 6000 });
  assert.equal(fits.mode, "search");
  assert.match(fits.passages.map((p) => p.text).join(""), /Opening hours: 7 to 19/);
  assert.ok(fits.passages.reduce((n, p) => n + p.title.length + 1 + p.text.length, 0) <= 6000);
  const tight = await passagesFor({ id: roomy }, "opening hours", "", { maxChars: 300 });
  assert.ok(tight.passages.length === 1 && tight.passages[0].title.length + 1 + tight.passages[0].text.length <= 300);
});

test("passages are cut to 6,000 tokens after counting, and to 6,000 bytes when counting fails", async () => {
  const broad = "refund delivery gluten wombat harbour receipt flour oven loaves card";
  const all8 = await passagesFor({ id: bakery }, broad, "", { count: async () => 0 });
  assert.ok(all8.passages.length >= 3);
  const best = (await searchChunks(bakery, queryTerms(broad)))[0];

  // A counter that says a token a character: the lowest-ranked passages go until it's 6,000 or less.
  const seen: number[] = [];
  const perChar = async (ps: { title: string; text: string }[]) => {
    const n = ps.reduce((sum, p) => sum + p.title.length + p.text.length, 0) * 2;
    seen.push(n);
    return n;
  };
  const counted = await passagesFor({ id: bakery }, broad, "", { count: perChar });
  assert.ok(seen.length > 1 && seen.at(-1)! <= PASSAGE_TOKENS && seen.slice(0, -1).every((n) => n > PASSAGE_TOKENS), seen.join(" "));
  assert.ok(counted.passages.length < all8.passages.length);
  assert.ok(counted.passages.some((p) => p.text.includes(best.body.trim().slice(0, 40))), "the best match stays");

  const size = (ps: { title: string; text: string }[]) => ps.reduce((sum, p) => sum + bytes(p.title) + 1 + bytes(p.text), 0);
  for (const count of [
    undefined,
    async () => {
      throw new Error("counting is down");
    },
  ]) {
    const cut = await passagesFor({ id: bakery }, broad, "", { count });
    assert.ok(cut.passages.length > 0 && size(cut.passages) <= PASSAGE_TOKENS, String(size(cut.passages)));
  }
  // Whatever the count, one passage is always left, cut to the bytes cap.
  const huge = await passagesFor({ id: bakery }, broad, "", { count: async () => 10 ** 9 });
  assert.equal(huge.passages.length, 1);
  assert.ok(size(huge.passages) <= PASSAGE_TOKENS);
  // Multi-byte text is cut at a character's edge.
  const ja = await assistant("owner", "Japanese");
  const plain = "商品の価格と配送の説明です。".repeat(360);
  await file(ja, "ja.txt", `${plain}${"返金ポリシーについて説明します。".repeat(220)}${plain}`, { tokens: 7000 });
  const jaRead = await passagesFor({ id: ja }, "返金", "", { count: async () => 10 ** 9 });
  assert.ok(size(jaRead.passages) <= PASSAGE_TOKENS && !jaRead.passages[0].text.includes("�"));
});

test("at most 8 passages, with neighbouring chunks merged into one", async () => {
  const many = await assistant("owner", "Many");
  const own: Record<number, string> = {};
  for (let n = 1; n <= 20; n++) own[n] = `Quokka care note ${n}.`;
  await file(many, "Care.pdf", pdf(20, own, 5, 3000), { tokens: 400 * 20 });
  const read = await passagesFor({ id: many }, "quokka", "", { count: async () => 0 });
  assert.equal(read.passages.length, MAX_PASSAGES);

  // One long section about wombats, over three chunks running from page 4 into page 5.
  const run3 = await assistant("owner", "Run");
  const section = Array.from({ length: 10 }, (_, i) => `Wombat feeding step ${i}: the wombat eats grass and roots slowly.`).join(" ");
  const text = `--- Page 4 ---\n${filler(1100, 21)}\n\n${section}\n\n--- Page 5 ---\n${section}\n\n${filler(1100, 22)}\n\n--- Page 6 ---\n${filler(2000, 23)}`;
  const id = await file(run3, "Wombats.pdf", text, { tokens: 2500, exact: 0 });
  const chunks = await chunksOf(id);
  const hits = chunks.filter((c) => /wombat/i.test(c.body));
  assert.ok(hits.length >= 2 && hits.every((c, i) => i === 0 || c.seq === hits[i - 1].seq + 1), "the wombat chunks are neighbours");
  const merged = await passagesFor({ id: run3 }, "wombat", "", { count: async () => 0, named: true });
  assert.equal(merged.passages.length, 1);
  assert.equal(merged.passages[0].text, hits.map((c) => c.body).join("").trim());
  assert.equal(merged.passages[0].title, "Wombats.pdf, pages 4-5");
  const hidden = await passagesFor({ id: run3 }, "wombat", "", { count: async () => 0 });
  assert.equal(hidden.passages[0].title, "Passage 1, pages 4-5", "without file names, a number");
});

test("when nothing matches nothing is read, and Read the start of each file reads each file's start", async () => {
  for (const message of ["thanks!", "Thanks, see you soon", "ok", "and the"]) {
    const read = await passagesFor({ id: bakery }, message);
    assert.deepEqual(read, { mode: "none", passages: [], nomatch: true }, message);
  }
  const start = await passagesFor({ id: bakery }, "thanks!", "", { readStart: true, named: true, count: async () => 0 });
  assert.equal(start.mode, "start");
  assert.equal(start.nomatch, false);
  assert.deepEqual([...new Set(start.passages.map((p) => p.file))], ["Handbook.pdf", "Prices.xlsx", "notes.txt"]);
  for (const [fileId] of [[handbook], [prices], [notes]]) {
    const [first] = await chunksOf(fileId);
    assert.ok(start.passages.some((p) => p.fileId === fileId && p.text.startsWith(first.body.trim().slice(0, 60))), fileId);
  }
  // It only chooses among the assistant's own chunks: a matching message still reads the starts.
  const matched = await passagesFor({ id: bakery }, "refunds", "", { readStart: true, count: async () => 0 });
  assert.deepEqual(matched.passages.map((p) => p.text), (await passagesFor({ id: bakery }, "", "", { readStart: true, count: async () => 0 })).passages.map((p) => p.text));
});

test("the fallback ranker gives the same top result as the full-text index", async () => {
  for (const [message, page] of TOP_PAGES) assert.equal((await searchChunks(bakery, queryTerms(message), "index"))[0].label, page, message);
  // A word on one page counts for more than a word on five, in both.
  const rye = await assistant("owner", "Rye");
  const own: Record<number, string> = { 9: "Rye flour notes." };
  for (const n of [2, 4, 6, 8, 10]) own[n] = "Sourdough starter notes.";
  await file(rye, "Flours.pdf", pdf(12, own, 6), { tokens: 9000 });
  for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(rye, queryTerms("rye sourdough"), mode))[0].label, "9", mode);
  for (const message of ["How do refunds work?", "Do you deliver to the harbour?", "gluten-free loaves", "wombat cookies", "loaf 17 price", "receipt card refund"]) {
    const terms = queryTerms(message);
    const indexed = await searchChunks(bakery, terms, "index");
    const ranked = await searchChunks(bakery, terms, "fallback");
    assert.ok(indexed.length > 0, message);
    assert.equal(ranked[0]?.id, indexed[0].id, message);
    assert.deepEqual(new Set(ranked.map((r) => r.id)), new Set(indexed.map((r) => r.id)), `${message}: the same chunks match`);
    const everything = await all<{ id: number; body: string }>("SELECT id, body FROM assistant_chunks WHERE assistant_id = ? ORDER BY id", [bakery]);
    assert.equal(rankChunks(everything, terms)[0].id, indexed[0].id);
  }
});

test("explicit deletes leave no chunk or index row behind, with foreign keys off", async () => {
  const gone = await assistant("owner", "Going");
  const keep = await file(gone, "keep.txt", `${filler(4000, 31)}\n\nNarwhal keepsakes.`);
  const drop = await file(gone, "drop.txt", `${filler(6000, 32)}\n\nPlatypus postcards.`);
  const dropped = await chunksOf(drop);
  const before = await indexRows();
  assert.ok((await matching(gone, "platypus")).length === 1);

  const client = await db();
  await client.batch(removeFileRows("someone-else", gone, drop), "write");
  assert.equal((await chunksOf(drop)).length, dropped.length, "only the owner can");
  assert.equal(await indexRows(), before);

  await client.batch(removeFileRows("owner", gone, drop), "write");
  assert.deepEqual(await chunksOf(drop), []);
  assert.equal(await one("SELECT 1 FROM assistant_files WHERE id = ?", [drop]), null);
  assert.equal(await indexRows(), before - dropped.length, "the trigger took each chunk's index row");
  assert.deepEqual(await matching(gone, "platypus"), []);
  assert.equal((await matching(gone, "narwhal")).length, 1, "the other file stays");

  // An id is never given out again, so an index row left behind can't point at new text.
  const next = await file(gone, "new.txt", "Echidna egg cups.");
  assert.ok((await chunksOf(next))[0].id > Math.max(...dropped.map((c) => c.id)));

  // Deleting all of an assistant's chunks takes all of its index rows.
  await run("DELETE FROM assistant_chunks WHERE assistant_id = ?", [gone]);
  const left = await all("SELECT rowid FROM assistant_chunks_fts WHERE seg MATCH ?", [`"${tagOf(gone)}" *`]);
  assert.deepEqual(left, []);
  assert.equal((await chunksOf(keep)).length, 0);
});

test("a file that fails part way is taken out again, and chunks get their share of the tokens", async () => {
  const half = await assistant("owner", "Half");
  const text = filler(200_000, 41);
  const chunks = chunkText(text);
  assert.ok(chunks.length > 150);
  await run("CREATE TEMP TRIGGER fail_late BEFORE INSERT ON assistant_chunks WHEN NEW.seq = 150 BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const before = await indexRows();
  try {
    await assert.rejects(file(half, "big.txt", text), /disk full/);
  } finally {
    await run("DROP TRIGGER fail_late");
  }
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks WHERE assistant_id = ?", [half]))?.n, 0);
  assert.equal(await indexRows(), before);

  const ok = await file(half, "ok.txt", text, { tokens: 50_000 });
  const stored = await chunksOf(ok);
  assert.equal(stored.map((c) => c.body).join(""), text);
  for (const c of stored) assert.equal(c.tokens, Math.ceil((50_000 * c.body.length) / text.length));
});

test("assistant text takes no more than STORE_FACTOR times its bytes in the database", async () => {
  const client = await db();
  const sized = await assistant("owner", "Sized");
  const csv = sheet("Orders", Array.from({ length: 9000 }, (_, i) => [`${100000 + i}`, `Customer ${i % 997}`, `${(i * 7.31) % 400}`, `2026-0${(i % 9) + 1}-1${i % 9}`]));
  const kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん返金方針商品価格配送注文確認";
  const rnd = seeded(9);
  let ja = "";
  while (ja.length < 150_000) ja += Array.from({ length: 30 }, () => kana[Math.floor(rnd() * kana.length)]).join("") + (rnd() < 0.1 ? "。\n\n" : "。");
  for (const [name, text] of [
    ["prose", filler(400_000, 51, 20_000)],
    ["spreadsheet", csv],
    ["japanese", ja],
  ] as const) {
    await run("VACUUM");
    const start = await pagesUsed(client);
    await file(sized, name, text);
    const grown = ((await pagesUsed(client)) - start) * Number((await one<{ page_size: number }>("PRAGMA page_size"))?.page_size);
    const factor = grown / bytes(text);
    assert.ok(factor <= STORE_FACTOR, `${name}: ${factor.toFixed(2)}x`);
    assert.ok(factor > 1, `${name}: the text itself is kept (${factor.toFixed(2)}x)`);
  }
  const measured = await storageFactor();
  assert.ok(measured !== null && measured > 1 && measured <= STORE_FACTOR, String(measured));
});

test("/admin says the full-text index is in use, with the measured storage factor", async () => {
  const { adminStats } = await import("../src/lib/server/admin-stats.ts");
  const { assistantSearch } = JSON.parse(JSON.stringify(await adminStats(30)));
  assert.equal(assistantSearch.mode, "index");
  assert.equal(assistantSearch.factor, await storageFactor());
  assert.ok(assistantSearch.factor > 1);
});
