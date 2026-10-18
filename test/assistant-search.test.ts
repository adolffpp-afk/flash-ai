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
type Statement = Parameters<Awaited<ReturnType<typeof db>>["batch"]>[0][number];
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
/** What `f` asks the database: each statement, with how many rows it gave back. */
async function watched<T>(f: () => Promise<T>): Promise<{ result: T; seen: { sql: string; rows: number }[] }> {
  const client = await db();
  const { execute, batch } = client;
  const seen: { sql: string; rows: number }[] = [];
  const sqlOf = (s: Statement) => (typeof s === "string" ? s : Array.isArray(s) ? s[0] : s.sql);
  client.execute = (async (s: Statement, args?: never) => {
    const r = await execute.call(client, s as string, args);
    seen.push({ sql: sqlOf(s), rows: r.rows.length });
    return r;
  }) as typeof execute;
  client.batch = (async (ss: Statement[], mode?: "read" | "write") => {
    const rs = await batch.call(client, ss, mode);
    ss.forEach((s, i) => seen.push({ sql: sqlOf(s), rows: rs[i].rows.length }));
    return rs;
  }) as typeof batch;
  try {
    return { result: await f(), seen };
  } finally {
    client.execute = execute;
    client.batch = batch;
  }
}
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

test("chunks of a file the assistant doesn't list (a failed upload's) are never read", async () => {
  const payroll = "Payroll: Dana earns 9,000 a month, paid on the 25th.";
  await run("INSERT INTO assistant_chunks (assistant_id, file_id, seq, label, chars, tokens, body) VALUES (?, 'failed-upload', 0, '1', ?, 20, ?)", [bakery, payroll.length, payroll]);
  const orphan = (await one<{ id: number }>("SELECT MAX(id) AS id FROM assistant_chunks"))!.id;
  await run("INSERT INTO assistant_chunks_fts (rowid, seg) VALUES (?, ?)", [orphan, tagged(tagOf(bakery), payroll)]);
  try {
    for (const mode of ["index", "fallback"] as const) assert.deepEqual(await searchChunks(bakery, queryTerms("What does Dana earn?"), mode), [], mode);
    const asked = await passagesFor({ id: bakery }, "What does Dana earn? Payroll", "", { named: true });
    assert.ok(!asked.passages.some((p) => p.text.includes("Dana")), JSON.stringify(asked.passages.map((p) => p.title)));
    const start = await passagesFor({ id: bakery }, "", "", { readStart: true, count: async () => 0 });
    assert.ok(start.passages.length > 0 && !start.passages.some((p) => p.text.includes("Dana")));
  } finally {
    await run("DELETE FROM assistant_chunks WHERE id = ?", [orphan]);
  }
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
  assert.ok(seen.length === 2 && seen[1] <= PASSAGE_TOKENS && seen[0] > PASSAGE_TOKENS, seen.join(" "));
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
  // Whatever the count, one passage is always left, cut to the bytes cap, after two counts at most.
  let counts = 0;
  const huge = await passagesFor({ id: bakery }, broad, "", { count: async () => (counts++, 10 ** 9) });
  assert.equal(huge.passages.length, 1);
  assert.ok(size(huge.passages) <= PASSAGE_TOKENS);
  assert.equal(counts, 2);

  // A file of English and then Japanese, whose Japanese chunks take twice the tokens their share of
  // the file's count says: the second count fits, and keeps most of what the first held.
  const mixed = await assistant("owner", "Mixed");
  const kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
  const rnd = seeded(17);
  const block = (i: number) => Array.from({ length: 1100 }, () => kana[Math.floor(rnd() * kana.length)]).join("") + (i % 2 ? "。\n\n" : "。返金について。\n\n");
  const jaText = Array.from({ length: 30 }, (_, i) => block(i)).join("");
  const cost = (t: string) => (t.match(/[\u3040-\u30ff\u4e00-\u9fff]/g)?.length ?? 0) + Math.ceil(t.replace(/[\u3040-\u30ff\u4e00-\u9fff]/g, "").length / 4);
  const both = `${filler(60_000, 18)}\n\n${jaText}`;
  await file(mixed, "Handbook.txt", both, { tokens: cost(both), exact: 0 });
  const rounds: number[] = [];
  const read = await passagesFor({ id: mixed }, "返金", "", { count: async (ps) => (rounds.push(ps.reduce((n, p) => n + cost(p.title) + cost(p.text), 0)), rounds.at(-1)!) });
  assert.ok(rounds.length === 2 && rounds[0] > PASSAGE_TOKENS && rounds[1] <= PASSAGE_TOKENS, rounds.join(" "));
  assert.ok(rounds[1] > PASSAGE_TOKENS * 0.7 && read.passages.length > 1, `${rounds[1]} tokens in ${read.passages.length} passages`);
  // Multi-byte text is cut at a character's edge.
  const ja = await assistant("owner", "Japanese");
  const plain = "商品の価格と配送の説明です。".repeat(360);
  await file(ja, "ja.txt", `${plain}${"返金ポリシーについて説明します。".repeat(220)}${plain}`, { tokens: 7000 });
  const jaRead = await passagesFor({ id: ja }, "返金", "", { count: async () => 10 ** 9 });
  assert.ok(size(jaRead.passages) <= PASSAGE_TOKENS && !jaRead.passages[0].text.includes("�"));
  // Characters outside the BMP (emoji, rarer Chinese characters) are two code units: no cut, by
  // bytes or by characters at an odd or even limit, leaves half of one.
  const half = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const halves: string[] = [];
  for (let lead = 1; lead <= 4; lead++) {
    const astral = await assistant("owner", `Astral ${lead}`);
    await file(astral, "astral.txt", Array.from({ length: 5 }, () => `${"x".repeat(lead)} refund ${"\u{2000B}".repeat(590)}`).join("\n\n"), { exact: 0 });
    const failing = async () => {
      throw new Error("counting is down");
    };
    for (const [how, o] of [["bytes", { count: failing }], ["3001 characters", { maxChars: 3001 }], ["3002 characters", { maxChars: 3002 }]] as const) {
      const read = await passagesFor({ id: astral }, "refund", "", o);
      assert.ok(read.passages.length > 0, how);
      for (const p of read.passages) if (half.test(p.text)) halves.push(`${how}, lead ${lead}: ${JSON.stringify(p.text.slice(-2))}`);
    }
  }
  assert.deepEqual(halves, []);
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

  // A short page or slide that shares a chunk is named in the title of what's read from it.
  const short = await assistant("owner", "Short pages");
  await file(short, "Handbook.pdf", `--- Page 1 ---\n${filler(1500, 24)}\n\n--- Page 2 ---\nRefunds are paid within 14 days.`, { exact: 0 });
  await file(short, "Deck.pptx", Array.from({ length: 10 }, (_, i) => `--- Slide ${i + 1} ---\n${i === 6 ? "Wombat pricing: 4 euros." : `Slide ${i + 1} heading`}`).join("\n\n"), { exact: 0 });
  const refund = await passagesFor({ id: short }, "How are refunds paid?", "", { named: true, count: async () => 0 });
  assert.deepEqual(refund.passages.map((p) => p.title), ["Handbook.pdf, pages 1-2"]);
  const wombat = await passagesFor({ id: short }, "wombat pricing", "", { named: true, count: async () => 0 });
  assert.deepEqual(wombat.passages.map((p) => p.title), ["Deck.pptx, Slide 1 to Slide 10"]);
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

  // With 20 files, it reads only what it can use: the start of the first 8, 24 chunks between them.
  const twenty = await assistant("owner", "Twenty files");
  const ids: string[] = [];
  for (let n = 1; n <= 20; n++) ids.push(await file(twenty, `f${n}.txt`, filler(6000, 70 + n), { exact: 0 }));
  const { result, seen } = await watched(() => passagesFor({ id: twenty }, "", "", { readStart: true, count: async () => 0 }));
  const read = seen.filter((q) => /FROM assistant_chunks/.test(q.sql));
  assert.equal(read.length, 1);
  assert.ok(read[0].rows <= 24, `${read[0].rows} chunks read`);
  assert.deepEqual([...new Set(result.passages.map((p) => p.fileId))], ids.slice(0, MAX_PASSAGES));
});

test("a searched message reads the chunk count from the files, and counts its words in the index alone", async () => {
  for (const f of [handbook, prices, notes]) {
    assert.equal(Number((await one<{ chunks: number }>("SELECT chunks FROM assistant_files WHERE id = ?", [f]))?.chunks), (await chunksOf(f)).length);
  }
  for (const message of ["How do refunds work?", "thanks!", "and the price of the loaves in the shop"]) {
    const { seen } = await watched(() => passagesFor({ id: bakery }, message));
    assert.ok(!seen.some((q) => /COUNT\(\*\)[^]*FROM assistant_chunks WHERE/.test(q.sql)), seen.map((q) => q.sql).join("\n"));
    // Not every match of "the" joined to its chunk and its file.
    const counts = seen.filter((q) => /COUNT\(\*\)/.test(q.sql));
    assert.ok(counts.length > 0 && counts.every((q) => !/JOIN|assistant_chunks\b(?!_fts)/.test(q.sql)), counts.map((q) => q.sql).join("\n"));
  }
});

test("the fallback ranker finds the same chunks as the full-text index, and the same best page", async () => {
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

test("Korean and Arabic questions find words written with a particle or vowel marks, in both searches", async () => {
  const shop = await assistant("owner", "Shop");
  const ko = "환불은 결제 후 14일 이내에 가능합니다. 환불을 받으려면 영수증이 필요합니다. 배송비는 환불되지 않습니다.";
  const ar = "سياسة الإرجاع: يُرجى إرسال الإيصال أولًا. تعذّر الاسترداد بعد ثلاثين يومًا. لطفاً";
  await file(shop, "Guide.pdf", pdf(8, { 3: ko, 6: ar }, 9), { exact: 0 });
  const asked = [
    ["환불 기간", "3"],
    ["배송비 환불", "3"],
    ["영수증이 필요한가요?", "3"],
    ["يرجى ارسال الايصال", "6"],
    ["تعذر الاسترداد", "6"],
    ["أولا لطفا", "6"],
  ];
  for (const [question, page] of asked) {
    for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(shop, queryTerms(question), mode))[0]?.label, page, `${mode}: ${question}`);
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
  const version = async () => Number((await one<{ version: number }>("SELECT version FROM assistants WHERE id = ?", [gone]))?.version);
  await client.batch(removeFileRows("someone-else", gone, drop), "write");
  assert.equal((await chunksOf(drop)).length, dropped.length, "only the owner can");
  assert.ok(await one("SELECT 1 FROM assistant_files WHERE id = ?", [drop]));
  assert.equal(await indexRows(), before);
  assert.equal(await version(), 0);

  await client.batch(removeFileRows("owner", gone, drop), "write");
  assert.equal(await version(), 1, "a new version, as its answers change");
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

test("an index without the trigger that keeps it clean isn't used, and storing a file makes the trigger and clears what was left meanwhile", async () => {
  const { adminStats } = await import("../src/lib/server/admin-stats.ts");
  const left = await assistant("owner", "Left");
  await file(left, "left.txt", `${filler(6000, 61)}\n\nMarmalade on Mondays.`);
  await run("DROP TRIGGER assistant_chunks_gone");
  try {
    assert.equal(await searchMode(true), "fallback");
    assert.equal(JSON.parse(JSON.stringify(await adminStats(30))).assistantSearch.mode, "fallback");
    assert.match((await passagesFor({ id: bakery }, "How do refunds work?")).passages.map((p) => p.text).join(""), /paid within 14 days/, "search still works");
    // Chunks deleted now leave their index rows behind.
    await run("DELETE FROM assistant_chunks WHERE assistant_id = ?", [left]);
    assert.equal((await matching(left, "marmalade")).length, 1);
  } finally {
    const mended = await assistant("owner", "Mended");
    await file(mended, "a.txt", "Quince jam on Sundays.");
  }
  assert.ok(await one("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'assistant_chunks_gone'"));
  assert.deepEqual(await matching(left, "marmalade"), [], "the rows left behind went with it");
  assert.equal(await indexRows(), Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks"))?.n), "an index row for every chunk, and no more");
  assert.equal(await searchMode(true), "index");
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

  // Chunks a failed upload left when deleting them failed too: the next upload deletes them, with
  // their index rows, so they can't make a word look common.
  await run("INSERT INTO assistant_chunks (assistant_id, file_id, seq, chars, tokens, body) VALUES (?, 'failed-upload', 0, 9, 3, 'Gooseberry')", [half]);
  await run("INSERT INTO assistant_chunks_fts (rowid, seg) SELECT MAX(id), ? FROM assistant_chunks", [tagged(tagOf(half), "Gooseberry")]);
  assert.equal((await matching(half, "gooseberry")).length, 1);
  const ok = await file(half, "ok.txt", text, { tokens: 50_000 });
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks WHERE file_id = 'failed-upload'"))?.n, 0);
  assert.deepEqual(await matching(half, "gooseberry"), []);
  const stored = await chunksOf(ok);
  assert.equal(stored.map((c) => c.body).join(""), text);
  for (const c of stored) assert.equal(c.tokens, Math.ceil((50_000 * c.body.length) / text.length));
});

test("assistant text takes no more than STORE_FACTOR times its bytes in the database, lists of short codes aside, as /admin measures it", async () => {
  const client = await db();
  // Starting with no assistant text, so /admin's measure of all of it is the growth measured here.
  await run("DELETE FROM assistant_chunks");
  await run("DELETE FROM assistant_files");
  await run("VACUUM");
  const page = Number((await one<{ page_size: number }>("PRAGMA page_size"))?.page_size);
  const empty = await pagesUsed(client);
  let stored = 0;
  const sized = await assistant("owner", "Sized");
  const csv = sheet("Orders", Array.from({ length: 9000 }, (_, i) => [`${100000 + i}`, `Customer ${i % 997}`, `${(i * 7.31) % 400}`, `2026-0${(i % 9) + 1}-1${i % 9}`]));
  const kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん返金方針商品価格配送注文確認";
  const rnd = seeded(9);
  let ja = "";
  while (ja.length < 150_000) ja += Array.from({ length: 30 }, () => kana[Math.floor(rnd() * kana.length)]).join("") + (rnd() < 0.1 ? "。\n\n" : "。");
  // Every 3-character code, ten to a row: each word is new, and costs the index about its own size.
  const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  const codes = [...ALNUM].flatMap((a) => [...ALNUM].flatMap((b) => [...ALNUM].map((c) => a + b + c)));
  const codeSheet = sheet("Codes", Array.from({ length: Math.ceil(codes.length / 10) }, (_, i) => codes.slice(i * 10, i * 10 + 10)));
  for (const [name, text, most] of [
    ["prose", filler(400_000, 51, 20_000), STORE_FACTOR],
    ["spreadsheet", csv, STORE_FACTOR],
    ["japanese", ja, STORE_FACTOR],
    // A marker line as long as a page of text is text, not a label copied into every chunk.
    ["marker line", `--- Sheet: ${"x".repeat(20_000)} ---\n${filler(100_000, 52)}`, STORE_FACTOR],
    // Lists of short codes take more than is counted (see STORE_FACTOR), but not without bound.
    ["codes", codeSheet, 4],
  ] as const) {
    await run("VACUUM");
    const start = await pagesUsed(client);
    await file(sized, name, text);
    const grown = ((await pagesUsed(client)) - start) * page;
    const factor = grown / bytes(text);
    assert.ok(factor <= most, `${name}: ${factor.toFixed(2)}x`);
    assert.ok(factor > 1, `${name}: the text itself is kept (${factor.toFixed(2)}x)`);
    stored += bytes(text);
  }
  const grown = ((await pagesUsed(client)) - empty) * page;
  const measured = await storageFactor(true);
  assert.ok(measured !== null && measured <= STORE_FACTOR, String(measured));
  assert.ok(Math.abs(measured - grown / stored) < 0.15, `/admin says ${measured.toFixed(2)}x, the database grew ${(grown / stored).toFixed(2)}x`);
});

test("/admin says the full-text index is in use, with the storage factor measured at most once a day", async (t) => {
  const { adminStats } = await import("../src/lib/server/admin-stats.ts");
  const measures = (seen: { sql: string }[]) => seen.filter((q) => /\bdbstat\b/.test(q.sql)).length;
  const { result, seen } = await watched(() => adminStats(30));
  const { assistantSearch } = JSON.parse(JSON.stringify(result));
  assert.equal(assistantSearch.mode, "index");
  assert.equal(assistantSearch.factor, await storageFactor());
  assert.ok(assistantSearch.factor > 1);
  assert.equal(measures(seen), 0, "the measure the storage test took today");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 25 * 3600_000 });
  const later = await watched(() => storageFactor());
  assert.equal(measures(later.seen), 1, "a day later, measured again");
  assert.equal(measures((await watched(() => adminStats(30))).seen), 0);
});
