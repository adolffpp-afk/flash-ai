import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

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
const { indexFile, passagesFor, purgeIndex, searchChunks, searchMode, removeFileRows, storageFactor } = search;
const { chunkText, queryTerms, rankChunks, tagOf, tagged, words } = await import("../src/lib/assistant-chunks.ts");
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
type Seen = { sql: string; args: unknown[]; rows: number };
const sqlOf = (s: Statement) => (typeof s === "string" ? s : Array.isArray(s) ? s[0] : s.sql);
const argsOf = (s: Statement): unknown[] => (typeof s === "string" ? [] : (((Array.isArray(s) ? s[1] : s.args) ?? []) as unknown[]));
/**
 * What `f` asks the database: each statement and its arguments, with how many rows it gave back,
 * and the same by call, a batch being one call: each call is a round trip to Turso.
 */
async function watched<T>(f: () => Promise<T>): Promise<{ result: T; seen: Seen[]; calls: Seen[][] }> {
  const client = await db();
  const { execute, batch } = client;
  const seen: Seen[] = [];
  const calls: Seen[][] = [];
  client.execute = (async (s: Statement, args?: never) => {
    const r = await execute.call(client, s as string, args);
    const one = { sql: sqlOf(s), args: args ?? argsOf(s), rows: r.rows.length };
    seen.push(one);
    calls.push([one]);
    return r;
  }) as typeof execute;
  client.batch = (async (ss: Statement[], mode?: "read" | "write") => {
    const rs = await batch.call(client, ss, mode);
    const these = ss.map((s, i) => ({ sql: sqlOf(s), args: argsOf(s), rows: rs[i].rows.length }));
    seen.push(...these);
    calls.push(these);
    return rs;
  }) as typeof batch;
  try {
    return { result: await f(), seen, calls };
  } finally {
    client.execute = execute;
    client.batch = batch;
  }
}
const matching = async (assistantId: string, word: string) =>
  (await all<{ rowid: number }>("SELECT rowid FROM assistant_chunks_fts WHERE seg MATCH ?", [`"${tagOf(assistantId)}${word}"`])).map((r) => Number(r.rowid));
/** Whether the index's own pages hold a word, searched or not: what SQL, a dump or a copy of the database reads. */
const inIndexPages = async (word: string) => (await all<{ block: ArrayBuffer }>("SELECT block FROM assistant_chunks_fts_data")).some((r) => Buffer.from(r.block).includes(word));
let copies = 0;
/** The bytes of a copy of the database, as VACUUM INTO writes it: its rows, without its free pages. */
async function copied(): Promise<Buffer> {
  const path = join(dir, `copy${++copies}.db`);
  await run("VACUUM INTO ?", [path]);
  const bytes = readFileSync(path);
  rmSync(path);
  return bytes;
}

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

test("files that fit are read whole, with their names, in order, on every message, without a search", async () => {
  const small = await assistant("owner", "Small");
  const a = filler(1800, 11);
  const b = `${filler(1500, 12)}\n\nOpening hours: 7 to 19.`;
  // 5,980 tokens, and the names "File 1" and "File 2" (or "Menu.txt" and "Hours.txt"), which go
  // with the files, counted by their bytes: a token is never shorter than a byte.
  await file(small, "Menu.txt", a, { tokens: 2490 });
  await file(small, "Hours.txt", b, { tokens: 3490 });
  for (const message of ["thanks!", "", "What are the opening hours?"]) {
    const read = await passagesFor({ id: small }, message);
    assert.equal(read.mode, "whole", message);
    assert.deepEqual(read.passages.map((p) => [p.title, p.text]), [["File 1", a], ["File 2", b]]);
  }
  assert.deepEqual((await passagesFor({ id: small }, "", "", { named: true })).passages.map((p) => p.title), ["Menu.txt", "Hours.txt"]);
  // One more file, of a token and its name: over, and the files are searched instead. So are they
  // when a count was only an estimate.
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
  // Long names, which go with each file: under the cap without them, over with them, and searched
  // when they're sent. "File 1" and "File 2" fit.
  const named = await assistant("owner", "Long names");
  const long = (n: number) => `社内マニュアル第${n}版`.padEnd(116, "（営業部・店舗運営・返品と交換の手続き）") + ".pdf";
  await file(named, long(1), filler(2000, 16), { tokens: 2900 });
  await file(named, long(2), `${filler(2000, 17)}\n\nOpening hours: 7 to 19.`, { tokens: 2900 });
  assert.equal((await passagesFor({ id: named }, "opening hours")).mode, "whole");
  let counted = 0;
  const count = async (ps: { title: string; text: string }[]) => ((counted += 1), ps.reduce((n, p) => n + bytes(p.title) + 1 + Math.ceil(bytes(p.text) / 4), 0));
  const read = await passagesFor({ id: named }, "opening hours", "", { named: true, count });
  assert.equal(read.mode, "search");
  assert.ok(counted > 0 && (await count(read.passages)) <= PASSAGE_TOKENS);
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

  // One passage a little over at the first count, as the start of a single file always is (its
  // chunks are neighbours), with a count that was scaled up from the file's start: cut at the
  // tokens per byte that count found and counted again, not cut to 6,000 bytes.
  const manual = await assistant("owner", "Manual");
  await file(manual, "Manual.txt", filler(200_000, 19), { exact: 0 });
  const tally: number[] = [];
  const counter = async (ps: { title: string; text: string }[]) => (tally.push(Math.ceil(size(ps) / 3.4)), tally.at(-1)!);
  const startRead = await passagesFor({ id: manual }, "", "", { readStart: true, count: counter });
  assert.equal(startRead.passages.length, 1);
  assert.ok(tally.length === 2 && tally[0] > PASSAGE_TOKENS && tally[1] <= PASSAGE_TOKENS, tally.join(" "));
  assert.ok(tally[1] > PASSAGE_TOKENS * 0.8, `${tally[1]} tokens kept`);

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

test("a searched message reads the chunk count from the files, and counts its words in the index alone, in 3 round trips at most", async () => {
  for (const f of [handbook, prices, notes]) {
    assert.equal(Number((await one<{ chunks: number }>("SELECT chunks FROM assistant_files WHERE id = ?", [f]))?.chunks), (await chunksOf(f)).length);
  }
  // A product named in the same 20 of 100 chunks: its three words' counts come to 60, more than
  // the index ranks, though only 20 chunks match.
  const manual = await assistant("owner", "Manual");
  await file(manual, "Manual.txt", Array.from({ length: 100 }, (_, i) => `${filler(1000, 700 + i)}\n\n${i % 5 === 0 ? `The Wombat Turbo Blender, section ${i}.` : `Section ${i}.`}`).join("\n\n"), { exact: 0 });
  // Which search the database has is asked at most once every 10 minutes, not for each message.
  await searchMode(true);
  for (const [id, message] of [
    [bakery, "How do refunds work?"],
    [bakery, "thanks!"],
    [bakery, "and the price of the loaves in the shop"],
    [manual, "How loud is the Wombat Turbo Blender?"],
  ]) {
    const { seen, calls } = await watched(() => passagesFor({ id }, message));
    assert.ok(!seen.some((q) => /COUNT\(\*\)[^]*FROM assistant_chunks WHERE/.test(q.sql)), seen.map((q) => q.sql).join("\n"));
    // Not every match of "the" joined to its chunk and its file.
    const counts = seen.filter((q) => /COUNT\(\*\)/.test(q.sql) && !/bm25/.test(q.sql));
    assert.ok(counts.length > 0 && counts.every((q) => !/JOIN|assistant_chunks\b(?!_fts)/.test(q.sql)), counts.map((q) => q.sql).join("\n"));
    // One after the other, each waiting for the last: the files, all the word counts in one batch,
    // then the ranked search.
    const trips = calls.map((c) => c.map((q) => q.sql.slice(0, 40)).join(" + "));
    assert.ok(calls.length <= 3, `${message}: ${trips.join(" | ")}`);
    assert.equal(calls.filter((c) => c.some((q) => /COUNT\(\*\)/.test(q.sql) && !/bm25/.test(q.sql))).length, 1, `${message}: ${trips.join(" | ")}`);
    if (id === manual) assert.equal(seen.filter((q) => /bm25/.test(q.sql))[0]?.rows, 20, "every chunk that names it, from one ranked search");
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

test("Korean, Arabic, Persian and Thai questions find words written with a particle, vowel marks, another form of a letter or ำ, in both searches", async () => {
  const shop = await assistant("owner", "Shop");
  const ko = "환불은 결제 후 14일 이내에 가능합니다. 환불을 받으려면 영수증이 필요합니다. 배송비는 환불되지 않습니다.";
  const ar = "سياسة الإرجاع: يُرجى إرسال الإيصال أولًا. تعذّر الاسترداد بعد ثلاثين يومًا. لطفاً";
  // Persian written with the Arabic yeh and kaf, as text from Word and older sites often is, and
  // Arabic with alef maqsura and teh marbuta, which are often typed as yeh and heh.
  const fa = "سياست بازگشت: كالا تا هفت روز پس از تحويل قابل بازگشت است. لطفاً رسيد خريد را نگه داريد.";
  const ar2 = "المستشفى مفتوح يوميا. مدة الإقامة القصوى في الغرفة سبعة أيام.";
  // "Goods can be returned within seven days. Large orders of goods ship free for every customer."
  const th = "การคืนสินค้าทำได้ภายในเจ็ดวัน สินค้าจำนวนมากส่งฟรีสำหรับลูกค้าทุกคน";
  await file(shop, "Guide.pdf", pdf(12, { 3: ko, 6: ar, 8: fa, 10: ar2, 11: th }, 9), { exact: 0 });
  assert.ok(words(th).includes(words("สินค้า")[0]), "ำ doesn't cut the words next to it");
  const asked = [
    ["환불 기간", "3"],
    ["배송비 환불", "3"],
    ["영수증이 필요한가요?", "3"],
    ["يرجى ارسال الايصال", "6"],
    ["تعذر الاسترداد", "6"],
    ["أولا لطفا", "6"],
    ["رسید خرید", "8"],
    ["تحویل کالا", "8"],
    ["المستشفي", "10"],
    ["مده الاقامه", "10"],
    ["สินค้า", "11"],
    ["จำนวน", "11"],
    ["สำหรับลูกค้า", "11"],
  ];
  for (const [question, page] of asked) {
    for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(shop, queryTerms(question), mode))[0]?.label, page, `${mode}: ${question}`);
  }
});

test("CO2, letters typed without their stroke and digits typed on a Persian or Arabic keyboard find what the file writes, in both searches", async () => {
  const lab = await assistant("owner", "Lab");
  const own: Record<number, string> = {
    2: "Scope 1 CO₂ emissions fell by a third, and so did CH₄ and N₂O.",
    4: "The flat is 75 m² and its pump moves 30 m³/h of H₂O.",
    // "Payment by card works in the shop", "The order was delivered in two days", "You can buy gift
    // cards in the shop", "The product's price includes shipping", "The cake's size is 26 cm".
    6: "Płatność kartą działa w sklepie.",
    8: "Đơn hàng được giao trong hai ngày.",
    9: "Du kan købe gavekort i butikken.",
    10: "Ürün fiyatı kargo dahil.",
    12: "Die Größe der Torte ist 26 cm.",
  };
  await file(lab, "Report.pdf", pdf(14, own, 12), { exact: 0 });
  // Order numbers as a spreadsheet writes them, in 0-9.
  const orders = await file(lab, "Orders.xlsx", sheet("Orders", [["order", "total"], ...Array.from({ length: 400 }, (_, i) => [`${30000 + 7 * i}`, `${(i % 50) + 10}.00`])]), { exact: 0 });
  const asked = [
    ["CO2", "2"],
    ["N2O emissions", "2"],
    ["m2", "4"],
    ["H2O", "4"],
    ["platnosc karta", "6"],
    ["płatność", "6"],
    ["don hang duoc giao", "8"],
    ["kobe gavekort", "9"],
    ["fiyati", "10"],
    ["Grösse der Torte", "12"],
  ];
  for (const [question, page] of asked) {
    for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(lab, queryTerms(question), mode))[0]?.label, page, `${mode}: ${question}`);
  }
  // Order 30707, typed in 0-9 and in Persian, Arabic and Devanagari digits.
  const holding = (await chunksOf(orders)).find((c) => c.body.includes("\n30707,"))!;
  for (const question of ["30707", "سفارش ۳۰۷۰۷", "الطلب ٣٠٧٠٧", "ऑर्डर ३०७०७"]) {
    for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(lab, queryTerms(question), mode))[0]?.id, holding.id, `${mode}: ${question}`);
  }
});

test("a short word with ™, № or a footnote's small digit written onto it is found by the word alone, in both searches", async () => {
  const shop = await assistant("owner", "Marks");
  const own: Record<number, string> = {
    3: "The Acme™ blender has a 2 litre jug and a five year warranty.",
    5: "We accept Visa™ and Mastercard® at the counter.",
    6: "Orders over 50 euros ship free; a handling fee² applies to bulky items.",
    9: "Breakfast is served in Room №12 from seven.",
  };
  await file(shop, "Guide.pdf", pdf(12, own, 4), { exact: 0 });
  for (const [question, page] of [["acme", "3"], ["Do you take Visa?", "5"], ["fee", "6"], ["room 12", "9"]]) {
    for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(shop, queryTerms(question), mode))[0]?.label, page, `${mode}: ${question}`);
  }
  const read = await passagesFor({ id: shop }, "Do you take Visa?");
  assert.deepEqual([read.mode, read.passages.map((p) => p.label)], ["search", ["page 5"]]);
});

test("explicit deletes leave no chunk or index row behind, with foreign keys off, nor any of the file's words in the index's pages", async () => {
  const gone = await assistant("owner", "Going");
  const keep = await file(gone, "keep.txt", `${filler(4000, 31)}\n\nNarwhal keepsakes.`);
  // Words no other file has, nor any of the filler's: in the index's pages as written.
  const secret = ["jacaranda", "wolframite", "4111222233334444"];
  const drop = await file(gone, "drop.txt", `${filler(6000, 32)}\n\nPlatypus postcards. Jacaranda Wolframite, card 4111222233334444.`);
  const dropped = await chunksOf(drop);
  const before = await indexRows();
  assert.ok((await matching(gone, "platypus")).length === 1);
  for (const word of secret) assert.ok(await inIndexPages(word), word);

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
  // The trigger only marks the rows deleted: their words stay in the index's pages, and so in any
  // copy of the database, until it has been rewritten without them.
  for (const word of secret) assert.ok(await inIndexPages(word), word);
  assert.ok((await copied()).includes("wolframite"));
  assert.equal(await purgeIndex(), true, "rewritten");
  for (const word of secret) assert.equal(await inIndexPages(word), false, word);
  const copy = await copied();
  for (const word of [...secret, "Wolframite"]) assert.equal(copy.includes(word), false, `${word} in a copy`);
  assert.ok(await inIndexPages("narwhal"));
  assert.equal(await indexRows(), before - dropped.length);
  assert.equal((await matching(gone, "narwhal")).length, 1, "and search still finds the rest");
  // Rewriting takes the whole index, so it's done at most once a day: the words of a file deleted
  // later that day stay until the first delete a day after.
  const later = await file(gone, "later.txt", `${filler(6000, 33)}\n\nQuokka quillwort.`);
  await client.batch(removeFileRows("owner", gone, later), "write");
  assert.equal(await purgeIndex(), false, "not again the same day");
  assert.ok(await inIndexPages("quillwort"));
  assert.equal(await purgeIndex(Date.now() + 24 * 3600_000), true);
  assert.equal(await inIndexPages("quillwort"), false);

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

test("an upload stores 100 chunks a batch, each with its index row and the file's count so far: search works while it runs and after it stops", async () => {
  const shop = await assistant("owner", "Uploading");
  await file(shop, "Handbook.pdf", pdf(14, { 3: REFUNDS, 7: DELIVERY, 11: GLUTEN }));
  // A big file that mentions refunds every 4,000 characters: part of it already holds them in more
  // chunks than half of what the handbook has.
  const big = Array.from({ length: 75 }, (_, i) => `${filler(4000, 300 + i)}\n\nRefund note ${i}: refunds for order batch ${i} go through the desk.`).join("\n\n");
  const listed = async (id: string) => {
    await run(
      "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, exact, hash, created_at) VALUES (?, ?, 'Orders.txt', 'text', ?, ?, ?, ?, 0, ?, ?)",
      [id, shop, big.length, bytes(big), STORE_FACTOR * bytes(big), Math.ceil(bytes(big) / 4), id, ++files],
    );
  };
  const counted = async () => ({
    files: Number((await one<{ n: number }>("SELECT SUM(chunks) AS n FROM assistant_files WHERE assistant_id = ?", [shop]))?.n),
    chunks: Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_chunks WHERE assistant_id = ?", [shop]))?.n),
  });
  const client = await db();
  const { batch } = client;
  const writes: Statement[][] = [];
  const during: { nomatch: boolean; files: number; chunks: number }[] = [];
  client.batch = (async (ss: Statement[], mode?: "read" | "write") => {
    const rs = await batch.call(client, ss, mode);
    if (mode === "write") {
      writes.push(ss);
      // A message that comes while the upload runs.
      during.push({ nomatch: (await passagesFor({ id: shop }, "How do refunds work?")).nomatch, ...(await counted()) });
    }
    return rs;
  }) as typeof batch;
  try {
    await listed("uploading");
    await indexFile(shop, "uploading", big, Math.ceil(bytes(big) / 4));
  } finally {
    client.batch = batch;
  }
  const chunks = chunkText(big);
  assert.equal(writes.length, Math.ceil(chunks.length / 100));
  writes.forEach((w, i) => {
    const sqls = w.map(sqlOf);
    const stored = sqls.filter((q) => q.startsWith("INSERT INTO assistant_chunks ")).length;
    assert.equal(stored, Math.min(100, chunks.length - 100 * i), `batch ${i + 1}`);
    // Each chunk with its index row, in the same batch.
    sqls.forEach((q, j) => {
      if (q.startsWith("INSERT INTO assistant_chunks ")) assert.ok(sqls[j + 1]?.startsWith("INSERT INTO assistant_chunks_fts") && argsOf(w[j + 1])[2] === argsOf(w[j])[2], `batch ${i + 1}, chunk ${j}`);
    });
    assert.match(sqls.at(-1)!, /^UPDATE assistant_files SET chunks = \?/);
    assert.equal(argsOf(w.at(-1)!)[0], Math.min(100 * (i + 1), chunks.length));
  });
  assert.equal(during.length, writes.length);
  for (const [i, d] of during.entries()) {
    assert.equal(d.files, d.chunks, `after batch ${i + 1}, the files count the chunks the index has`);
    assert.equal(d.nomatch, false, `after batch ${i + 1}, refunds are still a word that tells`);
  }

  // Stopped after its second batch, as a function past its time limit is: nothing after it runs,
  // not even the delete. What it stored is searched as it is, the same in both searches.
  let n = 0;
  client.batch = (async (ss: Statement[], mode?: "read" | "write") => {
    if (mode === "write" && ++n > 2) throw new Error("stopped");
    return batch.call(client, ss, mode);
  }) as typeof batch;
  try {
    await listed("stopped");
    await assert.rejects(indexFile(shop, "stopped", big, Math.ceil(bytes(big) / 4)), /stopped/);
  } finally {
    client.batch = batch;
  }
  assert.equal(Number((await one<{ chunks: number }>("SELECT chunks FROM assistant_files WHERE id = 'stopped'"))?.chunks), 200);
  const left = await counted();
  assert.equal(left.files, left.chunks);
  assert.equal((await passagesFor({ id: shop }, "How do refunds work?")).nomatch, false);
  for (const mode of ["index", "fallback"] as const) assert.ok((await searchChunks(shop, queryTerms("How do refunds work?"), mode)).length > 0, mode);
  for (const id of ["uploading", "stopped"]) await client.batch(removeFileRows("owner", shop, id), "write");
});

test("a file deleted while it's being stored gets no more chunks or index rows, and storing it fails", async () => {
  const shop = await assistant("owner", "Deleting");
  await file(shop, "Handbook.pdf", pdf(14, { 3: REFUNDS }));
  // A returns FAQ about refunds, 300 chunks, which the owner deletes once its first batch is stored.
  const faq = Array.from({ length: 300 }, (_, i) => `${filler(900, 900 + i)}\n\nRefund question ${i}: refunds and refund requests for order ${i}.`).join("\n\n");
  await run(
    "INSERT INTO assistant_files (id, assistant_id, name, kind, chars, bytes, stored, tokens, exact, hash, created_at) VALUES ('deleted-faq', ?, 'Returns FAQ.txt', 'text', ?, ?, ?, ?, 0, 'deleted-faq', ?)",
    [shop, faq.length, bytes(faq), STORE_FACTOR * bytes(faq), Math.ceil(bytes(faq) / 4), ++files],
  );
  const before = await indexRows();
  const client = await db();
  const { batch } = client;
  let writes = 0;
  // The file's chunks after each write that follows the delete.
  const left: number[] = [];
  client.batch = (async (ss: Statement[], mode?: "read" | "write") => {
    const rs = await batch.call(client, ss, mode);
    if (mode === "write" && ++writes === 1) await batch.call(client, removeFileRows("owner", shop, "deleted-faq"), "write");
    else if (mode === "write") left.push((await chunksOf("deleted-faq")).length);
    return rs;
  }) as typeof batch;
  try {
    await assert.rejects(indexFile(shop, "deleted-faq", faq, Math.ceil(bytes(faq) / 4)), /deleted while it was being stored/);
  } finally {
    client.batch = batch;
  }
  assert.ok(chunkText(faq).length > 200, "batches were left to store");
  // Nothing for a clean-up to delete, which might fail too, or never run.
  assert.equal(left[0], 0, "the batch after the delete stored nothing");
  assert.deepEqual(await chunksOf("deleted-faq"), [], "no chunk of the deleted file");
  assert.equal(await indexRows(), before, "nor any index row");
  assert.equal(await one("SELECT 1 FROM assistant_files WHERE id = 'deleted-faq'"), null);
  // So refunds are a word that tells again, and both searches find the handbook's page 3.
  for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(shop, queryTerms("How do refunds work?"), mode))[0]?.label, "3", mode);
  assert.equal((await passagesFor({ id: shop }, "How do refunds work?")).nomatch, false);
});

test("a search ranks its matches in the index and joins only the best of them to their chunks: the same ones as joining them all", async () => {
  // Words of an ordinary question in nearly half the chunks, which tell all the same.
  const wide = await assistant("owner", "Wide");
  const text = Array.from({ length: 120 }, (_, i) => `${filler(1000, 500 + i)}\n\n${i % 12 < 5 ? "The oven timer rings twice." : i % 3 === 0 ? "Set the timer first." : "Wipe the counter."}`).join("\n\n");
  await file(wide, "Kitchen.txt", text, { exact: 0 });
  const terms = queryTerms("How do I set the oven timer?");
  const { result, seen } = await watched(() => searchChunks(wide, terms, "index"));
  const query = seen.find((q) => /bm25/.test(q.sql))!;
  const matched = await all<{ rowid: number }>("SELECT rowid FROM assistant_chunks_fts WHERE seg MATCH ?", [query.args[0] as string]);
  assert.ok(matched.length > 48 && result.length === 24, `${matched.length} chunks match`);
  // On a client of its own: libSQL leaves an EXPLAIN in progress, which would stop a VACUUM.
  const side = createClient({ url: process.env.DATABASE_URL! });
  const plan = (await side.execute({ sql: `EXPLAIN QUERY PLAN ${query.sql}`, args: query.args as string[] })).rows as unknown as { id: number; parent: number; detail: string }[];
  side.close();
  const ranked = plan.find((r) => /^(CO-ROUTINE|MATERIALIZE) m$/.test(r.detail));
  assert.ok(ranked && plan.some((r) => r.parent === ranked.id && /^SCAN assistant_chunks_fts\b/.test(r.detail)), plan.map((r) => r.detail).join("\n"));
  const loops = plan.filter((r) => r.parent === 0 && /^(SCAN|SEARCH) /.test(r.detail)).map((r) => r.detail);
  assert.match(loops[0], /^SCAN m\b/, "the best matches first");
  assert.match(loops[1], /^SEARCH c USING INTEGER PRIMARY KEY/, "then each one's chunk");
  const joinedAll = await all<{ id: number }>(
    `SELECT c.id FROM assistant_chunks_fts f CROSS JOIN assistant_chunks c ON c.id = f.rowid
     JOIN assistant_files af ON af.id = c.file_id AND af.assistant_id = c.assistant_id
     WHERE f.seg MATCH ? AND c.assistant_id = ? ORDER BY bm25(assistant_chunks_fts), c.id LIMIT 24`,
    query.args as string[],
  );
  assert.deepEqual(result.map((r) => Number(r.id)), joinedAll.map((r) => Number(r.id)));
});

test("stray index rows that outrank the assistant's own chunks don't take their places: the index finds what the fallback finds", async () => {
  const shop = await assistant("owner", "Strays");
  const book = await file(shop, "Handbook.pdf", pdf(70, { 3: REFUNDS }));
  // 50 chunks of an upload that failed, when deleting them failed too, each about refunds over and
  // over, with their index rows: until the assistant's next upload, they outrank its own.
  const stray = "Refund refunds refund requests refund times refund cards refund receipts.";
  for (let seq = 0; seq < 50; seq++) {
    await run("INSERT INTO assistant_chunks (assistant_id, file_id, seq, chars, tokens, body) VALUES (?, 'failed-upload', ?, ?, 20, ?)", [shop, seq, stray.length, stray]);
    await run("INSERT INTO assistant_chunks_fts (rowid, seg) SELECT MAX(id), ? FROM assistant_chunks", [tagged(tagOf(shop), stray)]);
  }
  try {
    const terms = queryTerms("How do refunds work?");
    assert.ok((await chunksOf(book)).length > 2 * 52, "refunds still tell");
    const { result, seen } = await watched(() => searchChunks(shop, terms, "index"));
    const fallback = await searchChunks(shop, terms, "fallback");
    assert.equal(result[0]?.label, "3");
    assert.deepEqual(result.map((r) => r.id), fallback.map((r) => r.id));
    assert.equal(seen.filter((q) => /bm25/.test(q.sql)).length, 2, "searched again with every match");
    assert.equal((await passagesFor({ id: shop }, "How do refunds work?")).nomatch, false);
  } finally {
    await run("DELETE FROM assistant_chunks WHERE file_id = 'failed-upload'");
  }
});

test("Thai and Lao written with ำ or its halves, Lao ໜ and ໝ or their two letters, and Persian with or without its half-space find each other, in both searches", async () => {
  // "Fresh fruit every day", "Large orders of goods ship free for every customer", "Staff
  // duties", "Returns are due within seven days", "We can send the goods", "The books are on the
  // shelf".
  const written: Record<number, string> = {
    2: "ໝາກໄມ້ສົດທຸກມື້",
    4: "สินค้าจำนวนมากส่งฟรีสำหรับลูกค้าทุกคน",
    6: "ໜ້າທີ່ຂອງພະນັກງານ",
    8: "กำหนดส่งคืนสินค้าภายในเจ็ดวัน",
    10: "ما می\u200Cتوانیم کالا را ارسال کنیم.",
    12: "کتاب\u200Cها در قفسه هستند.",
  };
  // The other way: ำ as ํ and า, as many Thai PDFs give it, ໝ and ໜ as two letters, and no half-space.
  const other = (t: string) => t.replaceAll("ำ", "ํา").replaceAll("ໝ", "ຫມ").replaceAll("ໜ", "ຫນ").replaceAll("\u200C", "");
  const one = await assistant("owner", "Written one way");
  await file(one, "Guide.pdf", pdf(14, written, 16), { exact: 0 });
  const two = await assistant("owner", "Written the other");
  await file(two, "Guide.pdf", pdf(14, Object.fromEntries(Object.entries(written).map(([page, t]) => [page, other(t)])), 16), { exact: 0 });
  const asked = [["ໝາກໄມ້", "2"], ["จำนวน", "4"], ["สินค้า จำนวนมาก", "4"], ["สำหรับลูกค้า", "4"], ["ໜ້າທີ່", "6"], ["กำหนด", "8"], ["می\u200Cتوانیم", "10"], ["کتاب\u200Cها", "12"]];
  for (const [question, page] of asked) {
    for (const id of [one, two]) {
      for (const q of [question, other(question)]) {
        for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(id, queryTerms(q), mode))[0]?.label, page, `${mode}, ${id === one ? "one way" : "the other"}: ${q}`);
      }
    }
  }
});

test("a small digit in a Chinese clause doubles only the word it's on: the page that answers comes first, in both searches", async () => {
  // "Refunds reach the card within three working days" and "Buy the carbon-neutral package to cut
  // CO₂ emissions every year, refunds arrive".
  const shop = await assistant("owner", "Carbon");
  await file(shop, "Guide.pdf", pdf(12, { 3: "退款在三个工作日内到账，退款会退回原卡。", 7: "购买碳中和套餐每年可减少CO₂排放退款到账" }, 5), { exact: 0 });
  for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(shop, queryTerms("退款多久到账？"), mode))[0]?.label, "3", mode);
  for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(shop, queryTerms("CO2排放"), mode))[0]?.label, "7", mode);
});

test("a footnote's small digit on a short Arabic, Persian, Hebrew or Thai word is found by the word alone, in both searches", async () => {
  // "The price¹ includes tax", "The price² of the goods is fixed", "The price¹ includes shipping",
  // "Price¹ includes tax".
  const shop = await assistant("owner", "Footnotes");
  await file(shop, "Guide.pdf", pdf(10, { 3: "السعر يشمل الضريبة، سعر¹ ثابت.", 6: "قیمت² کالا ثابت است.", 8: "המחיר כולל משלוח, מחיר¹ קבוע.", 9: "ราคา¹รวมภาษีแล้ว" }, 6), { exact: 0 });
  for (const [question, page] of [["سعر", "3"], ["قیمت", "6"], ["מחיר", "8"], ["ราคา", "9"]]) {
    for (const mode of ["index", "fallback"] as const) assert.equal((await searchChunks(shop, queryTerms(question), mode))[0]?.label, page, `${mode}: ${question}`);
  }
});
