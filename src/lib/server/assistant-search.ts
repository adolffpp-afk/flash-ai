/*
 * What a message reads from an assistant's files (see assistant-chunks.ts for chunks and words).
 *
 * Each file is kept as chunks in assistant_chunks, and each chunk's words, tagged with its
 * assistant, in the full-text index assistant_chunks_fts, which keeps no copy of the text. A
 * database without FTS5 has no index: then the same search runs in JavaScript over the
 * assistant's chunks (rankChunks), which is slower and reads more rows. /admin says which. Both
 * find the same chunks; they can order them differently (see rankChunks).
 *
 * Nothing here deletes by cascade: Turso runs with foreign keys off. A chunk's index rows go with
 * it through the trigger on assistant_chunks, and those left while the trigger was missing go when
 * it's made (see mendAssistantIndex in db.ts). A failed upload's chunks are deleted with it, or at
 * the assistant's next upload. Word counts are the index's own, and a file's chunk count goes up
 * with each batch of its chunks and their index rows, so the two always agree. Every result is
 * joined back to its chunk and to a file the asking assistant lists, so a stray index row or a
 * chunk left by a failed upload can only ever find nothing.
 */
import type { InStatement } from "@libsql/client";
import { all, db, mendAssistantIndex, one, run } from "./db.ts";
import { MAX_PASSAGES, PASSAGE_TOKENS, type SearchMode } from "../assistants.ts";
import { chunkText, labelEnds, matchTerms, phraseOf, queryTerms, rankChunks, tagOf, tagged, tells, type Term } from "../assistant-chunks.ts";

const INDEX = "assistant_chunks_fts";
const TRIGGER = "assistant_chunks_gone";
// Set once a file's chunks were stored while the index was missing: those chunks aren't in it,
// so searching it would miss them, and every search uses the fallback from then on.
const UNINDEXED = "assistant_unindexed";

let checked: { mode: SearchMode; at: number } | null = null;
const CHECK_EVERY = 10 * 60_000;

/**
 * Whether the database has the index, whether it has the trigger that deletes a chunk's index rows
 * with it (init() makes the two one after the other, and the second can fail), and whether any
 * chunk was stored without the index. One read.
 */
async function indexState(): Promise<{ index: boolean; trigger: boolean; behind: boolean }> {
  const row = await one<{ index: number; trigger: number; behind: number }>(
    `SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? AND sql LIKE '%fts5%') AS "index",
            EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?) AS "trigger",
            EXISTS (SELECT 1 FROM settings WHERE key = ?) AS behind`,
    [INDEX, TRIGGER, UNINDEXED],
  );
  return { index: Boolean(Number(row?.index)), trigger: Boolean(Number(row?.trigger)), behind: Boolean(Number(row?.behind)) };
}

/**
 * How this database searches assistants' files: "index" with its full-text index and its trigger,
 * "fallback" without either. Asked of the database itself (not remembered from when this server
 * started), and kept for 10 minutes; `fresh` asks again now.
 */
export async function searchMode(fresh = false): Promise<SearchMode> {
  if (!fresh && checked && Date.now() - checked.at < CHECK_EVERY) return checked.mode;
  const { index, trigger, behind } = await indexState();
  checked = { mode: index && trigger && !behind ? "index" : "fallback", at: Date.now() };
  return checked.mode;
}

// Chunks per batch when storing a file, each with its index row, and the file's chunk count so far.
const PER_BATCH = 100;

/**
 * Stores a file's text as chunks, with their index rows when the database has the index (checked
 * again first, so no chunk is ever left out of an index that exists), 100 to a batch. Each batch
 * also sets the file's chunk count to the chunks stored so far, so the count words are weighed
 * against (see telling) always has every chunk the index has: during an upload, and after one
 * that was stopped part way, whose chunks are then searched as they are. The file's row is written
 * first, and deleted by the caller if this throws: only the chunks of a file the assistant lists
 * are ever read. `tokens` is the file's count; each chunk gets its share, rounded up. If any part
 * fails, the file's chunks are deleted, its count set back to 0, and the error is thrown. Chunks
 * of the assistant's that no file it lists has (a failed upload's, if deleting them failed too)
 * are deleted first, so they can't make its words look common.
 */
export async function indexFile(assistantId: string, fileId: string, text: string, tokens: number): Promise<{ chunks: number; indexed: boolean }> {
  const tag = tagOf(assistantId);
  const chunks = chunkText(text);
  const { index, trigger } = await indexState();
  // An index without its trigger would keep the rows of every chunk deleted from now on.
  if (index && !trigger) {
    await mendAssistantIndex(await db());
    checked = null;
  }
  const first: InStatement[] = [
    {
      sql: "DELETE FROM assistant_chunks WHERE assistant_id = ? AND file_id NOT IN (SELECT id FROM assistant_files WHERE assistant_id = ?)",
      args: [assistantId, assistantId],
    },
  ];
  // Without the index, mark first that chunks exist which it doesn't hold.
  if (!index) first.push({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')", args: [UNINDEXED] });
  const rows = (c: (typeof chunks)[number]): InStatement[] => [
    {
      sql: "INSERT INTO assistant_chunks (assistant_id, file_id, seq, label, chars, tokens, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [assistantId, fileId, c.seq, c.label, c.body.length, Math.ceil((tokens * c.body.length) / text.length), c.body],
    },
    ...(index
      ? [{ sql: `INSERT INTO ${INDEX} (rowid, seg) SELECT id, ? FROM assistant_chunks WHERE file_id = ? AND seq = ? ORDER BY id DESC LIMIT 1`, args: [tagged(tag, c.body), fileId, c.seq] }]
      : []),
  ];
  const batches: InStatement[][] = [];
  for (let from = 0; from === 0 || from < chunks.length; from += PER_BATCH) {
    const part = chunks.slice(from, from + PER_BATCH);
    batches.push([
      ...(from === 0 ? first : []),
      ...part.flatMap(rows),
      { sql: "UPDATE assistant_files SET chunks = ? WHERE id = ? AND assistant_id = ?", args: [from + part.length, fileId, assistantId] },
    ]);
  }
  const client = await db();
  try {
    for (const batch of batches) await client.batch(batch, "write");
  } catch (err) {
    await client
      .batch(
        [
          { sql: "DELETE FROM assistant_chunks WHERE assistant_id = ? AND file_id = ?", args: [assistantId, fileId] },
          { sql: "UPDATE assistant_files SET chunks = 0 WHERE id = ? AND assistant_id = ?", args: [fileId, assistantId] },
        ],
        "write",
      )
      .catch(() => {});
    throw err;
  }
  if (!index) checked = null;
  return { chunks: chunks.length, indexed: index };
}

const OWNED = "EXISTS (SELECT 1 FROM assistants WHERE id = ? AND user_id = ?)";

/**
 * The statements that delete one file of an assistant: its chunks (the trigger takes their index
 * rows), then the file, then a new version for the assistant, as its answers and price change.
 * Each does nothing unless the assistant is the user's. For a batch with whatever else the delete
 * changes.
 */
export function removeFileRows(userId: string, assistantId: string, fileId: string): InStatement[] {
  return [
    { sql: `DELETE FROM assistant_chunks WHERE assistant_id = ? AND file_id = ? AND ${OWNED}`, args: [assistantId, fileId, assistantId, userId] },
    { sql: `DELETE FROM assistant_files WHERE assistant_id = ? AND id = ? AND ${OWNED}`, args: [assistantId, fileId, assistantId, userId] },
    { sql: "UPDATE assistants SET version = version + 1 WHERE id = ? AND user_id = ?", args: [assistantId, userId] },
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
type FileRow = { id: string; name: string; exact: number; tokens: number; chunks: number };
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

/** Merges each file's neighbouring chunks (seq next to each other) into runs, in the order they were chosen. Only chunks of `fileIndex`'s files. */
function runsOf(rows: Row[], fileIndex: Map<string, number>): Run[] {
  const runs: Run[] = [];
  rows.forEach((row, rank) => {
    const file = fileIndex.get(row.file_id);
    if (file === undefined) return;
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
      const place = where(labelEnds(r.rows[0].label)[0], labelEnds(r.rows.at(-1)!.label)[1]);
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
 * MAX_PASSAGES passages, then cuts the passages to the exact cap: the lowest-ranked go first. They
 * are counted at most twice: over the cap, runs go until their bytes, at the tokens per byte that
 * count found (padded), fit, or one run is left and is cut to fit at that rate, and what's left is
 * counted again. Still over, or not counted, they're cut by bytes.
 */
async function choose(ranked: Row[], files: FileRow[], o: ReadOptions): Promise<Passage[]> {
  const fileIndex = new Map(files.map((f, i) => [f.id, i]));
  const taken: Row[] = [];
  let estimate = 0;
  for (const row of ranked) {
    if (estimate >= PASSAGE_TOKENS) break;
    if (!fileIndex.has(row.file_id)) continue;
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
  // The bytes the one run left keeps, when it's cut at the rate the first count found.
  let keep: number | undefined;
  for (let round = 0; round < 2 && runs.length && o.count; round++) {
    const passages = passagesOf(runs, files, named);
    if (keep !== undefined) passages[0].text = cutBytes(passages[0].text, keep);
    let tokens: number;
    try {
      tokens = await o.count(passages.map((p) => ({ title: p.title, text: p.text })));
    } catch {
      break;
    }
    if (tokens <= PASSAGE_TOKENS) return passages.filter((p) => p.text);
    if (round === 1) break;
    const perByte = (tokens / size(passages, bytes)) * ESTIMATE;
    while (runs.length > 1 && size(passagesOf(runs, files, named), bytes) * perByte > PASSAGE_TOKENS) runs = runs.slice(0, -1);
    const [only] = passagesOf(runs, files, named);
    // Never less than the cut by bytes, which always fits.
    if (runs.length === 1 && size([only], bytes) * perByte > PASSAGE_TOKENS) keep = Math.max(0, Math.max(Math.floor(PASSAGE_TOKENS / perByte), PASSAGE_TOKENS) - bytes(only.title) - 1);
  }
  return fit(PASSAGE_TOKENS, bytes, cutBytes);
}

// A chunk of a file the assistant lists: never one left by a failed upload, nor one an index row
// points at that is gone or someone else's.
const LISTED = "JOIN assistant_files af ON af.id = c.file_id AND af.assistant_id = c.assistant_id";
// The index's best matches, ranked in the index alone, and only those joined to their chunks and
// files (CROSS JOIN keeps SQLite to this order): joining every chunk a word is in before ranking
// would read most of an assistant's chunks for an ordinary question. Twice the candidates, so up
// to 24 stray index rows (see LISTED) can't take a place from the assistant's own chunks.
const RANKED = 2 * CANDIDATES;

/**
 * The terms that help choose between the assistant's `total` chunks (see tells), each counted in
 * the index alone: joining every match of a common word to its chunk and file would read thousands
 * of rows a message. Its rows are its chunks', and a failed upload's chunks go at the assistant's
 * next upload (see mendAssistantIndex in db.ts, and indexFile).
 */
async function telling(terms: Term[], tag: string, total: number): Promise<Term[]> {
  const counts = await (
    await db()
  ).batch(
    terms.map((t) => ({ sql: `SELECT COUNT(*) AS n FROM ${INDEX} WHERE seg MATCH ?`, args: [phraseOf(tag, t)] })),
    "read",
  );
  const found = counts.map((r) => Number(r.rows[0]?.n ?? 0));
  return terms.filter((_, i) => tells(found[i], total));
}

export type ChunkRow = { id: number; file_id: string; seq: number; label: string; tokens: number; body: string };

/**
 * The assistant's chunks that match the terms, best first, at most 24: from the index, or with
 * rankChunks over all its chunks when the database has none (`mode` says which, else searchMode).
 * `total` is how many chunks its files have (their chunks column), read from them when not given.
 */
export async function searchChunks(assistantId: string, terms: Term[], mode?: SearchMode, total?: number): Promise<ChunkRow[]> {
  if (!terms.length) return [];
  if ((mode ?? (await searchMode())) === "fallback") {
    const rows = await all<Row>(`SELECT c.id, c.file_id, c.seq, c.label, c.tokens, c.body FROM assistant_chunks c ${LISTED} WHERE c.assistant_id = ? ORDER BY c.id`, [assistantId]);
    return rankChunks(rows, terms).slice(0, CANDIDATES);
  }
  const tag = tagOf(assistantId);
  const chunks = total ?? Number((await one<{ n: number }>("SELECT COALESCE(SUM(chunks), 0) AS n FROM assistant_files WHERE assistant_id = ?", [assistantId]))?.n);
  const kept = await telling(terms, tag, chunks);
  if (!kept.length) return [];
  return all<Row>(
    `SELECT c.id, c.file_id, c.seq, c.label, c.tokens, c.body
     FROM (SELECT rowid AS id, bm25(${INDEX}) AS score FROM ${INDEX} WHERE seg MATCH ? ORDER BY score, rowid LIMIT ${RANKED}) m
     CROSS JOIN assistant_chunks c ON c.id = m.id ${LISTED}
     WHERE c.assistant_id = ?
     ORDER BY m.score, c.id LIMIT ${CANDIDATES}`,
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
  const files = await all<FileRow>("SELECT id, name, exact, tokens, chunks FROM assistant_files WHERE assistant_id = ? ORDER BY created_at, id", [a.id]);
  if (!files.length) return { mode: "none", passages: [], nomatch: false };
  const cols = "id, file_id, seq, label, tokens, body";
  // The chunks of these files (the first `perFile` of each), by the index on file and seq: the +
  // keeps SQLite off the one on assistant.
  const ofFiles = (fs: FileRow[], perFile?: number) =>
    all<Row>(
      `SELECT ${cols} FROM assistant_chunks WHERE +assistant_id = ? AND file_id IN (${fs.map(() => "?").join(", ")})${perFile ? " AND seq < ?" : ""} ORDER BY seq, id`,
      [a.id, ...fs.map((f) => f.id), ...(perFile ? [perFile] : [])],
    );

  if (files.every((f) => Number(f.exact) === 1) && files.reduce((sum, f) => sum + Number(f.tokens), 0) <= PASSAGE_TOKENS) {
    const rows = await ofFiles(files);
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
    // Only what choose can take: the first 8 files (a ninth would be a ninth passage), and 24
    // chunks between them.
    const starts = files.slice(0, MAX_PASSAGES);
    const rows = await ofFiles(starts, Math.ceil(CANDIDATES / starts.length));
    const order = new Map(files.map((f, i) => [f.id, i]));
    rows.sort((x, y) => x.seq - y.seq || (order.get(x.file_id) ?? 0) - (order.get(y.file_id) ?? 0));
    const passages = await choose(rows, files, o);
    return { mode: passages.length ? "start" : "none", passages, nomatch: false };
  }

  const ranked = await searchChunks(a.id, queryTerms(message, earlier), undefined, files.reduce((sum, f) => sum + Number(f.chunks), 0));
  if (!ranked.length) return { mode: "none", passages: [], nomatch: true };
  const passages = await choose(ranked, files, o);
  return { mode: passages.length ? "search" : "none", passages, nomatch: !passages.length };
}

// Below this much assistant text, the database's fixed pages would make any measure meaningless.
const MEASURE_FROM = 1024 * 1024;
// The last measure and when it was taken, kept in settings: measuring reads every page of every
// assistant's text, and the factor moves slowly.
const FACTOR = "assistant_store_factor";
const MEASURE_EVERY = 24 * 3600_000;

/**
 * How many times its UTF-8 size assistant text takes in the database (chunks, index and file
 * rows), measured from the database's own pages, or null before there is enough text or where the
 * database can't tell (no dbstat). Counted against storage as STORE_FACTOR. Measured at most once
 * a day, unless `fresh`.
 */
export async function storageFactor(fresh = false): Promise<number | null> {
  try {
    const kept = fresh ? null : await one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [FACTOR]);
    const last = kept ? (JSON.parse(kept.value) as { factor: number; at: number }) : null;
    if (last && typeof last.factor === "number" && Date.now() - last.at < MEASURE_EVERY) return last.factor;
  } catch {
    // Measured again below.
  }
  try {
    const text = await one<{ bytes: number }>("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM assistant_files");
    if (Number(text?.bytes) < MEASURE_FROM) return null;
    // Every table, index and index part of the chunks and files, by the table each belongs to.
    const used = await one<{ bytes: number }>(
      `SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat
       WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name LIKE 'assistant\\_chunks%' ESCAPE '\\' OR tbl_name = 'assistant_files')`,
    );
    const factor = Number(used?.bytes) / Number(text?.bytes);
    await run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [FACTOR, JSON.stringify({ factor, at: Date.now() })]).catch(() => {});
    return factor;
  } catch {
    return null;
  }
}
