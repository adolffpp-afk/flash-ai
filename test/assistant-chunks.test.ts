import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

/*
 * How an assistant's files are cut into chunks and searched: chunks that give back the file
 * exactly, labels from the readers' page, slide and sheet markers, words split for every
 * language, and a query nothing typed can break out of.
 */
const { chunkText, labelEnds, words, tagOf, tagged, queryTerms, matchQuery, matchTerms, rankChunks, tells } = await import("../src/lib/assistant-chunks.ts");
const { CHUNK_CHARS } = await import("../src/lib/assistants.ts");

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const para = (n: number, words = 30) => Array.from({ length: words }, (_, i) => `word${n}x${i}`).join(" ") + ".";
const pages = (n: number, paras = 8) => Array.from({ length: n }, (_, i) => `--- Page ${i + 1} ---\n${Array.from({ length: paras }, (_, j) => para(i * 100 + j)).join("\n\n")}`).join("\n\n");

/** Checks what every chunking must keep: no chunk over its size, nothing lost or repeated, no character cut in two. */
function wellCut(text: string, size = CHUNK_CHARS) {
  const chunks = chunkText(text, size);
  assert.equal(chunks.map((c) => c.body).join(""), text, "joined in order, the chunks are the text");
  chunks.forEach((c, i) => {
    assert.equal(c.seq, i);
    assert.ok(c.body.length > 0 && c.body.length <= size, `chunk ${i} is ${c.body.length}`);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(c.body) && !/[\uD800-\uDBFF]$/.test(c.body), `chunk ${i} doesn't cut a character in two`);
    // Only the end of a page, slide or sheet can be shorter.
    const next = chunks[i + 1]?.body ?? "";
    if (next && !next.startsWith("--- ")) assert.ok(c.body.length >= size / 2, `chunk ${i} isn't a sliver (${c.body.length})`);
  });
  return chunks;
}

test("chunks are labelled with the pages, slides or sheets they start and end on, and part n without one", () => {
  const pdf = wellCut(pages(6));
  assert.equal(pdf[0].label, "1");
  assert.deepEqual(
    [...new Set(pdf.map((c) => c.label))],
    ["1", "2", "3", "4", "5", "6"],
    "every page labels its chunks",
  );
  // A page is cut where it starts, so a chunk never begins on one page under another's label.
  for (const c of pdf) {
    const own = c.body.match(/--- Page (\d+) ---/);
    if (own && c.body.indexOf(own[0]) === 0) assert.equal(c.label, own[1]);
  }
  const pageThree = pdf.filter((c) => c.label === "3");
  assert.ok(pageThree[0].body.startsWith("--- Page 3 ---"));
  for (let n = 1; n <= 6; n++) assert.ok(pdf.some((c) => c.body.startsWith(`--- Page ${n} ---`) && c.label === `${n}`), `page ${n} starts a chunk`);
  // Short pages share a chunk, labelled with its first and last page.
  const short = wellCut(Array.from({ length: 40 }, (_, i) => `--- Page ${i + 1} ---\nPage ${i + 1} is short.`).join("\n\n"));
  assert.ok(short.length < 10);
  for (const c of short) {
    const own = [...c.body.matchAll(/--- Page (\d+) ---/g)].map((m) => m[1]);
    assert.deepEqual(labelEnds(c.label), [own[0], own.at(-1)]);
  }
  // A short page after a long one, at the end or before another long page, is named with it.
  const long1 = `--- Page 1 ---\n${para(1, 120)}\n\n${para(2, 60)}`;
  const two = wellCut(`${long1}\n\n--- Page 2 ---\nRefunds are paid within 14 days.`);
  assert.deepEqual(two.map((c) => c.label), ["1", "1\n2"]);
  const three = wellCut(`${long1}\n\n--- Page 2 ---\nRefunds are paid within 14 days.\n\n--- Page 3 ---\n${para(3, 300)}`);
  assert.equal(three.find((c) => c.body.includes("Refunds"))!.label, "1\n2");
  const deck = wellCut(Array.from({ length: 10 }, (_, i) => `--- Slide ${i + 1} ---\n${i === 6 ? "Wombat pricing" : `Slide ${i + 1} title`}`).join("\n\n"));
  assert.deepEqual(deck.map((c) => c.label), ["Slide 1\nSlide 10"]);
  assert.deepEqual(labelEnds("Sheet: A --- B"), ["Sheet: A --- B", "Sheet: A --- B"]);

  const slides = wellCut([para(1, 75), para(2, 75), para(3, 75)].map((t, i) => `--- Slide ${i + 1} ---\n${t}`).join("\n\n"));
  assert.deepEqual([...new Set(slides.map((c) => c.label))], ["Slide 1", "Slide 2", "Slide 3"]);

  const csv = (rows: number) => Array.from({ length: rows }, (_, i) => `${i},Loaf ${i},${(i * 1.5).toFixed(2)}`).join("\n");
  const sheets = wellCut(`--- Sheet: Prices ---\n${csv(200)}\n\n--- Sheet: A --- B ---\n${csv(100)}`);
  assert.deepEqual([...new Set(sheets.map((c) => c.label))], ["Sheet: Prices", "Sheet: A --- B"]);
  assert.ok(sheets.find((c) => c.label === "Sheet: A --- B")!.body.startsWith("--- Sheet: A --- B ---"));
  for (const c of sheets.slice(0, -1)) assert.ok(c.body.endsWith("\n"), "a sheet is cut between rows");

  // A marker line longer than a heading is text, not a label.
  const pasted = wellCut(`--- Sheet: ${"x".repeat(200_000)} ---\n${para(4, 400)}\n--- Page 1234567 ---\n${para(5, 400)}\n--- Sheet: ${"y".repeat(101)} ---\n`);
  assert.ok(pasted.every((c) => /^part \d+$/.test(c.label)), "every label a part");
  const kept = chunkText(`--- Sheet: ${"z".repeat(100)} ---\n${para(6, 400)}`);
  assert.equal(kept[0].label, `Sheet: ${"z".repeat(100)}`);

  const plain = wellCut([para(1, 200), para(2, 200)].join("\n\n"));
  assert.deepEqual(
    plain.map((c) => c.label),
    plain.map((_, i) => `part ${i + 1}`),
  );
});

test("no chunk is over its size and none overlaps: joined, they give back the text", () => {
  wellCut(pages(30, 12));
  wellCut(Array.from({ length: 300 }, (_, i) => `Sentence number ${i} says something about bread.`).join(" "), 500);
  wellCut("x".repeat(10_000), 700);
  wellCut("返金ポリシーについて。".repeat(800));
  wellCut("ราคาสินค้ารวมภาษีแล้ว".repeat(500));
  wellCut("🍞🥐🥖".repeat(1500), 301);
  wellCut("e\u0301".repeat(3000), 999);
  // A run of marks with no letter is cut inside, not mark by mark.
  const marks = wellCut("\u0301".repeat(10_000));
  assert.ok(marks.length <= Math.ceil(10_000 / (CHUNK_CHARS / 2)) + 1, `${marks.length} chunks`);
  wellCut(`x${"\u0301".repeat(5000)}y`, 999);
  wellCut("\u{1D165}".repeat(3000), 999);
  wellCut("\n\n\n".repeat(900) + "end");
  wellCut("short");
  assert.deepEqual(chunkText(""), []);
  // Paragraphs are kept whole where they fit: a chunk ends just after a blank line.
  const prose = Array.from({ length: 40 }, (_, i) => para(i, 25)).join("\n\n");
  for (const c of chunkText(prose).slice(0, -1)) assert.ok(c.body.endsWith("\n\n"), JSON.stringify(c.body.slice(-20)));
});

test("words are split for Japanese, Chinese and Thai, folded for accents and case, and each gets the tag", () => {
  assert.deepEqual(words("返金ポリシーについて"), ["返金", "ポリシー", "について"]);
  assert.deepEqual(words("退款政策是什么"), ["退款", "政策", "是", "什么"]);
  assert.deepEqual(words("ราคาสินค้ารวมภาษี"), ["ราคา", "สินค้า", "รวม", "ภาษี"]);
  assert.deepEqual(words("नमस्ते दुनिया"), ["नमस्ते", "दुनिया"], "vowel signs stay in the word");
  assert.deepEqual(words("Café CAFE cafe\u0301 Naïve"), ["cafe", "cafe", "cafe", "naive"]);
  assert.deepEqual(words("ﬁle ＡＢＣ ① -- ... !!"), ["file", "abc", "1"]);
  assert.ok(!words(`k${"x".repeat(80)} ok`).some((w) => w.length > 64), "a run too long to ask about isn't a word");
  const tag = tagOf(A);
  assert.equal(tag, "a0123456789abcdefx");
  assert.equal(tagged(tag, "Refunds, café"), `${tag}refunds ${tag}cafe`);
});

test("apostrophes split a word before tagging, so no piece goes untagged", () => {
  assert.deepEqual(words("l'été we're O\u2019Brien's"), ["l", "ete", "we", "re", "o", "brien", "s"]);
  const tag = tagOf(A);
  for (const text of ["l'été", "rock'n'roll", "O\u2019Brien", "x-y_z", "a.b.c", "co-op's"]) {
    for (const piece of tagged(tag, text).split(" ")) assert.ok(piece.startsWith(tag) && /^[\p{L}\p{N}\p{M}]+$/u.test(piece), `${text}: ${piece}`);
  }
});

test("an id that isn't hex can't make a tag", () => {
  assert.throws(() => tagOf("not-hex-at-all-0123456789abcdef"));
  assert.throws(() => tagOf("0123456789ABCDEF"));
  assert.throws(() => matchTerms("a0123x", [{ word: "x", prefix: false }]));
});

test("a short message is searched with the one before it, at most 16 different words, longer ones also as prefixes", () => {
  assert.deepEqual(
    queryTerms("and the price?", "Which loaves are gluten free"),
    [
      { word: "price", prefix: true },
      { word: "and", prefix: false },
      { word: "the", prefix: false },
      { word: "loave", prefix: true },
      { word: "gluten", prefix: true },
      { word: "which", prefix: true },
      { word: "free", prefix: false },
      { word: "are", prefix: false },
    ],
  );
  const long = "What does the bakery charge for delivering a birthday cake to the next town over";
  assert.ok(long.length >= 40);
  assert.ok(!queryTerms(long, "gluten").some((t) => t.word === "gluten"), "a long message stands alone");
  const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  assert.equal(queryTerms(many).length, 16);
  assert.deepEqual(queryTerms("Bread bread BREAD"), [{ word: "bread", prefix: true }]);
  assert.deepEqual(queryTerms("refunds"), [{ word: "refund", prefix: true }], "a plural s goes, so the singular is found");
  assert.deepEqual(queryTerms("refund refunds"), [{ word: "refund", prefix: true }]);
  assert.deepEqual(queryTerms("glass cups"), [{ word: "glass", prefix: true }, { word: "cups", prefix: false }]);
  assert.deepEqual(queryTerms("!!! ???"), []);
  assert.equal(matchQuery(tagOf(A), "?!"), "");
});

test("what's typed can't escape the query or reach another assistant's words", async () => {
  const tagA = tagOf(A);
  const tagB = tagOf(B);
  const hostile = [
    '"',
    '" OR "',
    `x" OR "y NEAR( * seg:`,
    "NEAR(refund policy, 2)",
    "refund AND policy NOT price",
    "refund*",
    "* OR *",
    "seg: refund",
    "{seg}: refund",
    "{x}: refund",
    "-refund ^policy +price",
    "(refund) OR (policy",
    `${tagB}refund`,
    `"${tagB}refund"`,
    `${tagB.slice(0, -1)} refund`,
  ];
  for (const text of hostile) {
    const q = matchQuery(tagA, text);
    if (!q) continue;
    for (const part of q.split(" OR ")) assert.match(part, new RegExp(`^"${tagA}[\\p{L}\\p{N}\\p{M}]+"( \\*)?$`, "u"), `${text}: ${part}`);
  }

  // And on a real full-text index: every query runs, and finds only the asking assistant's rows.
  const c = createClient({ url: ":memory:" });
  try {
    await c.execute(`CREATE VIRTUAL TABLE f USING fts5(seg, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'")`);
    await c.execute({ sql: "INSERT INTO f (rowid, seg) VALUES (1, ?), (2, ?)", args: [tagged(tagA, "Our refund policy covers price drops"), tagged(tagB, "Refund policy price near seg")] });
    for (const text of [...hostile, "refund policy price near seg"]) {
      const q = matchQuery(tagA, text);
      if (!q) continue;
      const rows = (await c.execute({ sql: "SELECT rowid FROM f WHERE seg MATCH ?", args: [q] })).rows.map((r) => Number(r.rowid));
      assert.ok(!rows.includes(2), `${text} reached the other assistant`);
    }
    const found = await c.execute({ sql: "SELECT rowid FROM f WHERE seg MATCH ?", args: [matchQuery(tagA, "refunds")] });
    assert.deepEqual(found.rows.map((r) => Number(r.rowid)), [1], "a word of 5 letters or more finds longer ones");
  } finally {
    c.close();
  }
});

test("the fallback ranker ranks with BM25 and leaves out words most chunks have", () => {
  const chunk = (body: string, id: number) => ({ id, body });
  const docs = [
    chunk("The refund policy: refunds within 30 days. Refund requests go to the shop.", 1),
    chunk("The opening hours of the shop are 8 to 6.", 2),
    chunk("The sourdough uses a refund-free starter.", 3),
    chunk("The cakes and the tarts.", 4),
    chunk("The delivery area covers the old town.", 5),
    chunk("The gluten free loaves are baked on Fridays.", 6),
  ];
  const ids = (terms: string, earlier = "") => rankChunks(docs, queryTerms(terms, earlier)).map((d) => d.id);
  assert.deepEqual(ids("how do refunds work"), [1, 3], "more of the word ranks higher");
  assert.deepEqual(ids("refunded?"), [], "a prefix finds only longer words");
  assert.deepEqual(ids("tell me about the"), [], "a word every chunk has says nothing");
  assert.deepEqual(ids("thanks!"), []);
  assert.deepEqual(ids("delivery"), [5]);
  assert.equal(tells(3, 6), false);
  assert.equal(tells(2, 6), true);
  assert.equal(tells(2, 3), true, "with few chunks every word found counts");
  assert.equal(tells(0, 3), false);
  assert.deepEqual(rankChunks(docs.slice(0, 2), queryTerms("the")).map((d) => d.id), [2, 1], "with few chunks, even common words count");
});
