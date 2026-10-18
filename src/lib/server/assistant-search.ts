/*
 * What a message reads from an assistant's files (see assistant-chunks.ts for chunks and words).
 *
 * Each file is kept as chunks in assistant_chunks, and each chunk's words, tagged with its
 * assistant, in the full-text index assistant_chunks_fts, which keeps no copy of the text. A
 * database without FTS5 has no index: then the same search runs in JavaScript over the
 * assistant's chunks (rankChunks), which is slower and reads more rows. /admin says which.
 *
 * Nothing here deletes by cascade: Turso runs with foreign keys off. A chunk's index rows go with
 * it through the trigger on assistant_chunks (see db.ts), and every result is joined back to its
 * chunk with the asking assistant's id, so a stray index row can only ever find nothing.
 */
import type { InStatement } from "@libsql/client";
import { all, db, one, run } from "./db.ts";
import { MAX_PASSAGES, PASSAGE_TOKENS, type SearchMode } from "../assistants.ts";
import { chunkText, matchTerms, phraseOf, queryTerms, rankChunks, tagOf, tagged, tells, type Term } from "../assistant-chunks.ts";

const INDEX = "assistant_chunks_fts";
// Set once a file's chunks were stored while the index was missing: those chunks aren't in it,
// so searching it would miss them, and every search uses the fallback from then on.
const UNINDEXED = "assistant_unindexed";

let checked: { mode: SearchMode; at: number } | null = null;
const CHECK_EVERY = 10 * 60_000;

/** Whether the database has the index, and whether any chunk was stored without it. One read. */
async function indexState(): Promise<{ index: boolean; behind: boolean }> {
  const row = await one<{ index: number; behind: number }>(
    `SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? AND sql LIKE '%fts5%') AS "index",
            EXISTS (SELECT 1 FROM settings WHERE key = ?) AS behind`,
    [INDEX, UNINDEXED],
  );
  return { index: Boolean(Number(row?.index)), behind: Boolean(Number(row?.behind)) };
}

/**
 * How this database searches assistants' files: "index" with its full-text index, "fallback"
 * without. Asked of the database itself (not remembered from when this server started), and kept
 * for 10 minutes; `fresh` asks again now.
 */
export async function searchMode(fresh = false): Promise<SearchMode> {
  if (!fresh && checked && Date.now() - checked.at < CHECK_EVERY) return checked.mode;
  const { index, behind } = await indexState();
  checked = { mode: index && !behind ? "index" : "fallback", at: Date.now() };
  return checked.mode;
}

// Statements per batch when storing a file: a chunk and its index row always go in the same one.
const BATCH = 200;

/**
 * Stores a file's text as chunks, with their index rows when the database has the index (checked
 * again first, so no chunk is ever left out of an index that exists). `tokens` is the file's
 * count; each chunk gets its share, rounded up. If any part fails, the file's chunks are deleted
 * and the error is thrown.
 */
export async function indexFile(assistantId: string, fileId: string, text: string, tokens: number): Promise<{ chunks: number; indexed: boolean }> {
  const tag = tagOf(assistantId);
  const chunks = chunkText(text);
  const { index } = await indexState();
  // Without the index, mark first that chunks exist which it doesn't hold.
  const statements: InStatement[] = index ? [] : [{ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')", args: [UNINDEXED] }];
  for (const c of chunks) {
    statements.push({
      sql: "INSERT INTO assistant_chunks (assistant_id, file_id, seq, label, chars, tokens, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [assistantId, fileId, c.seq, c.label, c.body.length, Math.ceil((tokens * c.body.length) / text.length), c.body],
    });
    if (index) {
      statements.push({
        sql: `INSERT INTO ${INDEX} (rowid, seg) SELECT id, ? FROM assistant_chunks WHERE file_id = ? AND seq = ? ORDER BY id DESC LIMIT 1`,
        args: [tagged(tag, c.body), fileId, c.seq],
      });
    }
  }
  try {
    const client = await db();
    for (let i = 0; i < statements.length; i += BATCH) await client.batch(statements.slice(i, i + BATCH), "write");
  } catch (err) {
    await run("DELETE FROM assistant_chunks WHERE assistant_id = ? AND file_id = ?", [assistantId, fileId]).catch(() => {});
    throw err;
  }
  if (!index) checked = null;
  return { chunks: chunks.length, indexed: index };
}

const OWNED = "EXISTS (SELECT 1 FROM assistants WHERE id = ? AND user_id = ?)";

/**
 * The statements that delete one file of an assistant: its chunks (the trigger takes their index
 * rows), then the file. Each does nothing unless the assistant is the user's. For a batch with
 * whatever else the delete changes.
 */
export function removeFileRows(userId: string, assistantId: string, fileId: string): InStatement[] {
  return [
    { sql: `DELETE FROM assistant_chunks WHERE assistant_id = ? AND file_id = ? AND ${OWNED}`, args: [assistantId, fileId, assistantId, userId] },
    { sql: `DELETE FROM assistant_files WHERE assistant_id = ? AND id = ? AND ${OWNED}`, args: [assistantId, fileId, assistantId, userId] },
  ];
}

export type Passage = { fileId: string; file: string; label: string; title: string; text: string };

export type Reading = {
  // whole: every file, as the files all fit; search: the best matches; start: the start of each
  // file (readStart); none: nothing, as no passage matched (nomatch) or there are no files.
  mode: "whole" | "search" | "start" | "none";
  passages: Passage[];
  nomatch: boolean;
};

/** The largest number of tokens the passages come to over the level models; may throw. */
export type PassageCounter = (passages: { title: string; text: string }[]) => Promise<number>;

export type ReadOptions = {
  // The person tapped "Read the start of each file": read that instead of searching.
  readStart?: boolean;
  // Titles name the files ("Handbook.pdf, page 4"); otherwise "Passage 2, page 4".
  named?: boolean;
  // Counts the passages, which are then cut to PASSAGE_TOKENS. Without one, or when it fails,
  // they're cut to PASSAGE_TOKENS bytes of UTF-8: a token is never shorter than a byte.
  count?: PassageCounter;
  // For free models, which cost nothing: passages up to this many characters, not counted.
  maxChars?: number;
};

type Row = ChunkRow;
type FileRow = { id: string; name: string; exact: number; tokens: number };
// Chunks of one file next to each other, read as one passage; rank is its best chunk's place.
type Run = { file: number; rows: Row[]; rank: number };

// Candidates the search reads, and how its token estimates are padded before the exact count.
const CANDIDATES = 24;
const ESTIMATE = 1.1;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The first `max` UTF-8 bytes of a text, at a character's edge. */
function cutBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(text.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return /[\uD800-\uDBFF]/.test(text[lo - 1] ?? "") ? text.slice(0, lo - 1) : text.slice(0, lo);
}

/** A passage's place in its file: "page 4", "pages 4-5", "Slide 3", "Sheet: Prices", "part 2". */
function where(first: string, last: string): string {
  const pages = /^\d+$/.test(first) && /^\d+$/.test(last);
  if (pages) return first === last ? `page ${first}` : `pages ${first}-${last}`;
  return first === last ? first : `${first} to ${last}`;
}

/** Merges each file's neighbouring chunks (seq next to each other) into runs, in the order they were chosen. */
function runsOf(rows: Row[], fileIndex: Map<string, number>): Run[] {
  const runs: Run[] = [];
  rows.forEach((row, rank) => {
    const file = fileIndex.get(row.file_id) ?? 0;
    const near = runs.filter((r) => r.file === file && r.rows.some((x) => Math.abs(x.seq - row.seq) === 1));
    if (!near.length) return void runs.push({ file, rows: [row], rank });
    // A chunk can join two runs into one (seq 3 between 2 and 4).
    const [keep, ...rest] = near;
    keep.rows.push(row, ...rest.flatMap((r) => r.rows));
    keep.rows.sort((a, b) => a.seq - b.seq);
    for (const r of rest) runs.splice(runs.indexOf(r), 1);
  });
  return runs;
}

/** The runs as passages, in file and seq order, each titled. */
function passagesOf(runs: Run[], files: FileRow[], named: boolean): Passage[] {
  return [...runs]
    .sort((a, b) => a.file - b.file || a.rows[0].seq - b.rows[0].seq)
    .map((r, i) => {
      const place = where(r.rows[0].label, r.rows.at(-1)!.label);
      const file = files[r.file];
      return {
        fileId: file.id,
        file: file.name,
        label: place,
        title: `${named ? file.name : `Passage ${i + 1}`}, ${place}`,
        text: r.rows.map((x) => x.body).join("").trim(),
      };
    });
}

/**
 * Takes chunks best first while their padded estimates fit PASSAGE_TOKENS and they make at most
 * MAX_PASSAGES passages, then cuts the passages to the exact cap: the lowest-ranked go first.
 */
async function choose(ranked: Row[], files: FileRow[], o: ReadOptions): Promise<Passage[]> {
  const fileIndex = new Map(files.map((f, i) => [f.id, i]));
  const taken: Row[] = [];
  let estimate = 0;
  for (const row of ranked) {
    if (estimate >= PASSAGE_TOKENS) break;
    const cost = row.tokens * ESTIMATE;
    if (estimate + cost > PASSAGE_TOKENS) continue;
    if (runsOf([...taken, row], fileIndex).length > MAX_PASSAGES) continue;
    taken.push(row);
    estimate += cost;
  }
  let runs = runsOf(taken, fileIndex).sort((a, b) => a.rank - b.rank);
  const named = Boolean(o.named);
  const size = (ps: Passage[], of: (s: string) => number) => ps.reduce((sum, p) => sum + of(p.title) + 1 + of(p.text), 0);
  /** Drops the lowest-ranked runs until the passages measure `max` or less, then cuts the last one left. */
  const fit = (max: number, of: (s: string) => number, cut: (s: string, n: number) => string) => {
    while (runs.length > 1 && size(passagesOf(runs, files, named), of) > max) runs = runs.slice(0, -1);
    const passages = passagesOf(runs, files, named);
    if (passages.length === 1 && size(passages, of) > max) {
      const p = passages[0];
      p.text = cut(p.text, Math.max(0, max - of(p.title) - 1));
    }
    return passages.filter((p) => p.text);
  };
  if (o.maxChars !== undefined) return fit(o.maxChars, (s) => s.length, (s, n) => s.slice(0, n).replace(/[\uD800-\uDBFF]$/, ""));
  while (runs.length && o.count) {
    const passages = passagesOf(runs, files, named);
    let tokens: number;
    try {
      tokens = await o.count(passages.map((p) => ({ title: p.title, text: p.text })));
    } catch {
      break;
    }
    if (tokens <= PASSAGE_TOKENS) return passages;
    if (runs.length === 1) break;
    runs = runs.slice(0, -1);
  }
  return fit(PASSAGE_TOKENS, bytes, cutBytes);
}

/** The terms that help choose between the assistant's chunks (see tells), from the index's own counts. */
async function telling(terms: Term[], tag: string, assistantId: string): Promise<Term[]> {
  const counts = await (
    await db()
  ).batch(
    [
      { sql: "SELECT COUNT(*) AS n FROM assistant_chunks WHERE assistant_id = ?", args: [assistantId] },
      ...terms.map((t) => ({ sql: `SELECT COUNT(*) AS n FROM ${INDEX} WHERE seg MATCH ?`, args: [phraseOf(tag, t)] })),
    ],
    "read",
  );
  const [total, ...found] = counts.map((r) => Number(r.rows[0]?.n ?? 0));
  return terms.filter((_, i) => tells(found[i], total));
}

export type ChunkRow = { id: number; file_id: string; seq: number; label: string; tokens: number; body: string };

/**
 * The assistant's chunks that match the terms, best first, at most 24: from the index, or with
 * rankChunks over all its chunks when the database has none (`mode` says which, else searchMode).
 */
export async function searchChunks(assistantId: string, terms: Term[], mode?: SearchMode): Promise<ChunkRow[]> {
  if (!terms.length) return [];
  if ((mode ?? (await searchMode())) === "fallback") {
    const rows = await all<Row>("SELECT id, file_id, seq, label, tokens, body FROM assistant_chunks WHERE assistant_id = ? ORDER BY id", [assistantId]);
    return rankChunks(rows, terms).slice(0, CANDIDATES);
  }
  const tag = tagOf(assistantId);
  const kept = await telling(terms, tag, assistantId);
  if (!kept.length) return [];
  return all<Row>(
    `SELECT c.id, c.file_id, c.seq, c.label, c.tokens, c.body
     FROM ${INDEX} f JOIN assistant_chunks c ON c.id = f.rowid
     WHERE f.seg MATCH ? AND c.assistant_id = ?
     ORDER BY bm25(${INDEX}), c.id LIMIT ${CANDIDATES}`,
    [matchTerms(tag, kept), assistantId],
  );
}

/**
 * What one message reads from an assistant's files:
 *  - every file, whole, when all were counted exactly and come to PASSAGE_TOKENS or less;
 *  - otherwise the chunks that best match the message (and, when it's short, the person's message
 *    before it), neighbours merged, at most MAX_PASSAGES passages and PASSAGE_TOKENS tokens;
 *  - nothing when no chunk matches (nomatch), or the start of each file with readStart.
 * Only this assistant's chunks can come back. Nothing the person types can add text: the options
 * only choose which of its chunks are read.
 */
export async function passagesFor(a: { id: string }, message: string, earlier = "", o: ReadOptions = {}): Promise<Reading> {
  const files = await all<FileRow>("SELECT id, name, exact, tokens FROM assistant_files WHERE assistant_id = ? ORDER BY created_at, id", [a.id]);
  if (!files.length) return { mode: "none", passages: [], nomatch: false };
  const cols = "id, file_id, seq, label, tokens, body";

  if (files.every((f) => Number(f.exact) === 1) && files.reduce((sum, f) => sum + Number(f.tokens), 0) <= PASSAGE_TOKENS) {
    const rows = await all<Row>(`SELECT ${cols} FROM assistant_chunks WHERE assistant_id = ? ORDER BY seq, id`, [a.id]);
    const passages = files
      .map((f, i) => ({
        fileId: f.id,
        file: f.name,
        label: "",
        title: o.named ? f.name : `File ${i + 1}`,
        text: rows.filter((r) => r.file_id === f.id).map((r) => r.body).join("").trim(),
      }))
      .filter((p) => p.text);
    const chars = passages.reduce((sum, p) => sum + p.title.length + 1 + p.text.length, 0);
    // More than a free model's room: searched, like a bigger assistant's files.
    if (o.maxChars === undefined || chars <= o.maxChars) return { mode: "whole", passages, nomatch: false };
  }

  if (o.readStart) {
    // The first chunks of each file in turn: the first of every file, then the second, and so on.
    const rows = await all<Row>(`SELECT ${cols} FROM assistant_chunks WHERE assistant_id = ? AND seq < ? ORDER BY seq, id`, [a.id, CANDIDATES]);
    const order = new Map(files.map((f, i) => [f.id, i]));
    rows.sort((x, y) => x.seq - y.seq || (order.get(x.file_id) ?? 0) - (order.get(y.file_id) ?? 0));
    const passages = await choose(rows, files, o);
    return { mode: passages.length ? "start" : "none", passages, nomatch: false };
  }

  const ranked = await searchChunks(a.id, queryTerms(message, earlier));
  if (!ranked.length) return { mode: "none", passages: [], nomatch: true };
  const passages = await choose(ranked, files, o);
  return { mode: passages.length ? "search" : "none", passages, nomatch: !passages.length };
}

// Below this much assistant text, the database's fixed pages would make any measure meaningless.
const MEASURE_FROM = 1024 * 1024;

/**
 * How many times its UTF-8 size assistant text takes in the database (chunks, index and file
 * rows), measured from the database's own pages, or null before there is enough text or where the
 * database can't tell (no dbstat). Counted against storage as STORE_FACTOR.
 */
export async function storageFactor(): Promise<number | null> {
  try {
    const text = await one<{ bytes: number }>("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM assistant_files");
    if (Number(text?.bytes) < MEASURE_FROM) return null;
    // Every table, index and index part of the chunks and files, by the table each belongs to.
    const used = await one<{ bytes: number }>(
      `SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat
       WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name LIKE 'assistant\\_chunks%' ESCAPE '\\' OR tbl_name = 'assistant_files')`,
    );
    return Number(used?.bytes) / Number(text?.bytes);
  } catch {
    return null;
  }
}
