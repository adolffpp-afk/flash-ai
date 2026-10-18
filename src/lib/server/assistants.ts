/*
 * An owner's assistants on the server: making, reading, changing and deleting them and their files
 * (see assistants.ts for the fields and their limits, assistant-search.ts for how files are kept).
 * Nothing here is reached while ASSISTANTS_ON is false: the routes answer 404 first.
 *
 * Every limit is checked in the same statement that writes, so two requests at once can't both get
 * past one. Turso runs with foreign keys off, so nothing is deleted by cascade: each delete is one
 * batch that names every table, each statement checking the assistant is the user's, followed by
 * purgeIndex. Every change to an assistant gives it a new version: an editor sends back the version
 * it read, and a change made since (on another device, or by an upload there) is refused, not lost.
 * Adding or deleting a file takes the editor's version too, and gives back a new one only when the
 * assistant was at the editor's version just before (see versionAfter).
 */
import { randomBytes } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { all, db, now, one } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { FREE_STORAGE_BYTES, USED_STORAGE_SQL, storageLimit, usedStorage } from "./site-files.ts";
import { fileDeletes, indexFile, purgeIndex, removeFileRows } from "./assistant-search.ts";
import { LEVEL_MODELS, countTextTokens } from "../engines/claude.ts";
import { CUT_NOTE } from "../office.ts";
import { isLevel, type Level } from "../levels.ts";
import {
  ASSISTANT_COLORS,
  MAX_ASSISTANTS,
  MAX_ASSISTANT_CHARS,
  MAX_ASSISTANT_FILES,
  MAX_FILE_CHARS,
  MAX_UPLOAD_BYTES,
  STORE_FACTOR,
  cleanAssistant,
  cleanFileName,
  isFileKind,
  validateAssistant,
  type AssistantFields,
  type AssistantFileKind,
  type AssistantProblem,
} from "../assistants.ts";

/**
 * Why a request about an assistant can't be done, as a code with its numbers: an AssistantProblem
 * with its fields, or one of these. The words are chosen where it's shown (refusalText in
 * assistant-routes.ts).
 */
export type Refusal =
  | AssistantProblem
  | { code: "not_found" }
  | { code: "bad_request" }
  | { code: "too_many_assistants"; max: number }
  | { code: "version_conflict"; version: number }
  | { code: "too_many_files"; max: number }
  | { code: "duplicate" }
  | { code: "assistant_full"; chars: number }
  | { code: "file_long"; chars: number }
  | { code: "upload_big"; bytes: number }
  | { code: "bad_file" }
  | { code: "storage"; used: number; limit: number }
  | { code: "daily_text" }
  | { code: "failed" };

export class AssistantError extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.code);
    this.refusal = refusal;
  }
}

const refuse = (refusal: Refusal): never => {
  throw new AssistantError(refusal);
};

/** The HTTP status a refusal is answered with. */
export function refusalStatus(r: Refusal): number {
  switch (r.code) {
    case "not_found":
      return 404;
    case "too_many_assistants":
    case "version_conflict":
    case "too_many_files":
    case "duplicate":
    case "assistant_full":
      return 409;
    case "file_long":
    case "upload_big":
      return 413;
    case "storage":
      return 507;
    case "daily_text":
      return 429;
    case "failed":
      return 500;
    default:
      return 400;
  }
}

/*
 * Every table that keeps something for an assistant by its assistant_id, deleted with it, those
 * that keep something for one of its files (FILE_TABLES) among them. A test checks every table
 * with an assistant_id column is here, except projects: a chat started with an assistant keeps its
 * messages when the assistant goes (its next message is refused instead).
 */
export const ASSISTANT_TABLES = ["assistant_visitors", "assistant_chunks", "assistant_files"] as const;

// How much text an owner can add to their assistants' files in a day: more on a paid plan.
export const DAILY_TEXT_FREE = 2_000_000;
export const DAILY_TEXT_PAID = 10_000_000;
const DAY = 24 * 3600_000;

// A file up to this long is counted whole; a longer one by its start (see fileTokens).
export const EXACT_CHARS = 50_000;

/** A new assistant's id: 32 hex digits, the first 16 of which tag its words in the search index. */
export const newAssistantId = () => randomBytes(16).toString("hex");

export type AssistantFile = {
  id: string;
  name: string;
  kind: AssistantFileKind;
  pages: number;
  chars: number;
  bytes: number;
  stored: number;
  tokens: number;
  exact: boolean;
  cut: boolean;
  createdAt: number;
};

export type AssistantSummary = { id: string; name: string; description: string; color: string; level: Level; files: number; updatedAt: number };

export type Assistant = AssistantFields & {
  id: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  files: AssistantFile[];
  storage: { used: number; limit: number };
};

type AssistantRow = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  starters: string;
  level: string;
  color: string;
  version: number;
  created_at: number;
  updated_at: number;
};
type FileRow = { id: string; name: string; kind: string; pages: number; chars: number; bytes: number; stored: number; tokens: number; exact: number; cut: number; created_at: number };

const FIELDS = "id, name, description, instructions, starters, level, color, version, created_at, updated_at";
const FILE_FIELDS = "id, name, kind, pages, chars, bytes, stored, tokens, exact, cut, created_at";
const OWNED = "EXISTS (SELECT 1 FROM assistants WHERE id = ? AND user_id = ?)";

const starterList = (json: string): string[] => {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
};
const fieldsOf = (r: AssistantRow): AssistantFields => cleanAssistant({ ...r, starters: starterList(r.starters) });
const fileOf = (f: FileRow): AssistantFile => ({
  id: f.id,
  name: f.name,
  kind: f.kind as AssistantFileKind,
  pages: Number(f.pages),
  chars: Number(f.chars),
  bytes: Number(f.bytes),
  stored: Number(f.stored),
  tokens: Number(f.tokens),
  exact: Boolean(Number(f.exact)),
  cut: Boolean(Number(f.cut)),
  createdAt: Number(f.created_at),
});

const ownRow = (userId: string, id: string) => one<AssistantRow>(`SELECT ${FIELDS} FROM assistants WHERE id = ? AND user_id = ?`, [id, userId]);

// The models a count is asked of: every level's, each once.
const countModels = () => [...new Set(Object.values(LEVEL_MODELS))];
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

/** The largest count of a text over every level's model, asked of each at the same time; throws if any count fails. */
async function largestCount(text: string): Promise<number> {
  return Math.max(...(await Promise.all(countModels().map((model) => countTextTokens(model, text)))));
}

/**
 * The tokens an assistant's instructions take, the largest count over every level's model: what a
 * message on any level pays for them. Their UTF-8 bytes when counting fails: no text has more
 * tokens than bytes. (A count also takes in the few tokens of the message around the text, so a
 * text of a few characters can count a few more than its bytes.) 0 for none.
 */
export async function countInstructionTokens(text: string): Promise<number> {
  if (!text) return 0;
  return largestCount(text).catch(() => utf8(text));
}

// What instr_tokens counts: the name and the instructions, as a message will carry them. The fixed
// words around them in the prompt aren't counted here.
const instructionText = (a: Pick<AssistantFields, "name" | "instructions">) => [a.name, a.instructions].filter(Boolean).join("\n\n");

/**
 * The tokens a file's text takes, the largest count over every level's model. Counted whole up to
 * EXACT_CHARS characters (exact); a longer text by its first EXACT_CHARS characters, scaled up by
 * whichever of its characters or bytes grows more, so a start that's mostly Latin can't make a
 * Chinese tail look small, and never more than its bytes. Its bytes when counting fails. No text
 * has more tokens than bytes; a count also takes in the few tokens of the message around the text
 * (see countInstructionTokens).
 */
export async function fileTokens(text: string): Promise<{ tokens: number; exact: boolean }> {
  const bytes = utf8(text);
  try {
    if (text.length <= EXACT_CHARS) return { tokens: await largestCount(text), exact: true };
    // Not between the two halves of a character written as two.
    const end = /[\uD800-\uDBFF]/.test(text[EXACT_CHARS - 1]) ? EXACT_CHARS - 1 : EXACT_CHARS;
    const start = text.slice(0, end);
    const scale = Math.max(text.length / start.length, bytes / utf8(start));
    return { tokens: Math.min(bytes, Math.ceil((await largestCount(start)) * scale)), exact: false };
  } catch {
    return { tokens: bytes, exact: false };
  }
}

/** The user's assistants, the latest changed first. */
export async function listAssistants(userId: string): Promise<AssistantSummary[]> {
  const rows = await all<AssistantRow & { files: number }>(
    `SELECT ${FIELDS}, (SELECT COUNT(*) FROM assistant_files f WHERE f.assistant_id = a.id) AS files
     FROM assistants a WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    [userId, MAX_ASSISTANTS],
  );
  return rows.map((r) => {
    const f = fieldsOf(r);
    return { id: r.id, name: f.name, description: f.description, color: f.color, level: f.level, files: Number(r.files), updatedAt: Number(r.updated_at) };
  });
}

/** One of the user's assistants, with its files and the user's storage; null when it isn't theirs. */
export async function getAssistant(userId: string, id: string): Promise<Assistant | null> {
  const row = await ownRow(userId, id);
  if (!row) return null;
  const [files, used, limit] = await Promise.all([
    all<FileRow>(`SELECT ${FILE_FIELDS} FROM assistant_files WHERE assistant_id = ? ORDER BY created_at, id`, [id]),
    usedStorage(userId),
    storageLimit(userId),
  ]);
  return {
    id: row.id,
    ...fieldsOf(row),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    files: files.map(fileOf),
    storage: { used, limit },
  };
}

// A version an editor read: a whole number, from 0.
const isVersion = (version: unknown): version is number => Number.isSafeInteger(version) && (version as number) >= 0;

/**
 * The version an editor that read `seen` saves at next, once a file it added or deleted has given
 * the assistant version `now`: `now` when the assistant was at `seen` just before, as nothing else
 * changed it since the editor read it; else `seen`, so that its next save is refused with the
 * version now and it reloads, and a change made on another device isn't saved over. Never a version
 * that takes in a change the editor hasn't seen.
 */
const versionAfter = (seen: number, now: number) => (now === seen + 1 ? now : seen);

// A level was sent that isn't one of Flash's ("summit" for "ultra", say): refused, never saved as
// another level.
const unknownLevel = (sent: unknown) =>
  Boolean(sent && typeof sent === "object" && Object.hasOwn(sent, "level") && !isLevel((sent as { level: unknown }).level));

const assistantCount = async (userId: string) => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [userId]))?.n ?? 0);
const unique = (err: unknown) => err instanceof Error && /UNIQUE/i.test(err.message);

/**
 * Makes an assistant for the user from what was sent (cleaned, then refused with its reason if
 * over a limit, and as a bad request for a level Flash doesn't have), with a colour of its own if
 * none was picked. Refused once the user has MAX_ASSISTANTS. Its id is new and starts with 16
 * digits no other assistant's does, so its words are tagged as its own (see tagOf in
 * assistant-chunks.ts); an id whose 16 are taken is made again. `newId` is for tests.
 */
export async function createAssistant(userId: string, input: unknown, o: { newId?: () => string } = {}): Promise<Assistant> {
  if (unknownLevel(input)) refuse({ code: "bad_request" });
  const fields = cleanAssistant(input);
  const problem = validateAssistant(fields);
  if (problem) refuse(problem);
  if ((await assistantCount(userId)) >= MAX_ASSISTANTS) refuse({ code: "too_many_assistants", max: MAX_ASSISTANTS });
  const color = fields.color || ASSISTANT_COLORS[randomBytes(1)[0] % ASSISTANT_COLORS.length];
  const tokens = await countInstructionTokens(instructionText(fields));
  const client = await db();
  for (let tries = 0; tries < 5; tries++) {
    const id = (o.newId ?? newAssistantId)();
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("An assistant's id is 32 hex digits.");
    const head = id.slice(0, 16);
    const at = now();
    const made = await client
      .execute({
        sql: `INSERT INTO assistants (id, user_id, name, description, instructions, starters, level, color, instr_tokens, version, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
              WHERE (SELECT COUNT(*) FROM assistants WHERE user_id = ?) < ?
                AND NOT EXISTS (SELECT 1 FROM assistants WHERE id >= ? AND id < ?)`,
        args: [id, userId, fields.name, fields.description, fields.instructions, JSON.stringify(fields.starters), fields.level, color, tokens, at, at, userId, MAX_ASSISTANTS, head, `${head}g`],
      })
      .catch((err) => {
        // Another assistant made at the same moment took the same 16 digits (assistants_tag).
        if (unique(err)) return { rowsAffected: 0 };
        throw err;
      });
    if (made.rowsAffected) return (await getAssistant(userId, id))!;
    if ((await assistantCount(userId)) >= MAX_ASSISTANTS) refuse({ code: "too_many_assistants", max: MAX_ASSISTANTS });
  }
  return refuse({ code: "failed" });
}

const EDITABLE = ["name", "description", "instructions", "starters", "level", "color"] as const;

/**
 * Changes the fields of one of the user's assistants that were sent, the others staying as they
 * are. `version` is the one the editor read: if the assistant changed since, nothing is written and
 * the refusal carries its version now. A level Flash doesn't have is a bad request. A change gives
 * it a new version; sending what it already has changes nothing. Its instructions are counted
 * again when its name or instructions change.
 */
export async function updateAssistant(userId: string, id: string, patch: unknown, version: number): Promise<Assistant> {
  if (!isVersion(version) || unknownLevel(patch)) refuse({ code: "bad_request" });
  const row = (await ownRow(userId, id)) ?? refuse({ code: "not_found" });
  if (Number(row.version) !== version) refuse({ code: "version_conflict", version: Number(row.version) });
  const was = fieldsOf(row);
  const sent = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...was };
  for (const key of EDITABLE) if (Object.hasOwn(sent, key)) merged[key] = sent[key];
  const next = cleanAssistant(merged);
  // A colour Flash doesn't have leaves the one it has.
  next.color ||= was.color;
  const problem = validateAssistant(next);
  if (problem) refuse(problem);
  if (JSON.stringify(next) === JSON.stringify(was)) return (await getAssistant(userId, id)) ?? refuse({ code: "not_found" });
  const recount = next.name !== was.name || next.instructions !== was.instructions;
  const tokens = recount ? await countInstructionTokens(instructionText(next)) : null;
  const done = await (await db()).execute({
    sql: `UPDATE assistants SET name = ?, description = ?, instructions = ?, starters = ?, level = ?, color = ?, instr_tokens = COALESCE(?, instr_tokens),
            version = version + 1, updated_at = ?
          WHERE id = ? AND user_id = ? AND version = ?`,
    args: [next.name, next.description, next.instructions, JSON.stringify(next.starters), next.level, next.color, tokens, now(), id, userId, version],
  });
  if (!done.rowsAffected) {
    // Changed or deleted between the read and the write.
    const current = await ownRow(userId, id);
    refuse(current ? { code: "version_conflict", version: Number(current.version) } : { code: "not_found" });
  }
  return (await getAssistant(userId, id)) ?? refuse({ code: "not_found" });
}

/**
 * Deletes one of the user's assistants and everything kept for it, in one batch: each table in
 * ASSISTANT_TABLES, then the assistant, each statement only while it's the user's. False when it
 * isn't theirs.
 */
export async function deleteAssistant(userId: string, id: string): Promise<boolean> {
  if (!(await ownRow(userId, id))) return false;
  const done = await (await db()).batch(
    [
      ...ASSISTANT_TABLES.map((table): InStatement => ({ sql: `DELETE FROM ${table} WHERE assistant_id = ? AND ${OWNED}`, args: [id, id, userId] })),
      { sql: "DELETE FROM assistants WHERE id = ? AND user_id = ?", args: [id, userId] },
    ],
    "write",
  );
  await purgeIndex().catch(() => {});
  return done.at(-1)!.rowsAffected > 0;
}

/**
 * Deletes one file of the user's assistant, its chunks and their index rows with it, and gives the
 * assistant a new version, in one batch that checks the file is there (see removeFileRows).
 * `version` is the one the editor read: the delete goes through whatever it is, and the version
 * given back is the one the editor saves at next (versionAfter). Null when there's no such file of
 * theirs, or another delete took it first.
 */
export async function deleteAssistantFile(userId: string, assistantId: string, fileId: string, version: number): Promise<number | null> {
  if (!isVersion(version)) refuse({ code: "bad_request" });
  const rows = removeFileRows(userId, assistantId, fileId);
  const done = await (await db()).batch([...rows, { sql: "SELECT version FROM assistants WHERE id = ? AND user_id = ?", args: [assistantId, userId] }], "write");
  // The file's own row is deleted last.
  if (!done[rows.length - 1].rowsAffected) return null;
  await purgeIndex().catch(() => {});
  return versionAfter(version, Number(done.at(-1)!.rows[0]?.version ?? 0));
}

/**
 * Deletes every assistant a user has and everything kept for them, and the user's own visits to
 * other people's assistants, in one batch. For whoever deletes an account: nothing in Flash does
 * yet (it's done by email, /delete-account).
 */
export async function deleteUserAssistants(userId: string): Promise<void> {
  await (await db()).batch(
    [
      ...ASSISTANT_TABLES.map((table): InStatement => ({ sql: `DELETE FROM ${table} WHERE assistant_id IN (SELECT id FROM assistants WHERE user_id = ?)`, args: [userId] })),
      { sql: "DELETE FROM assistant_visitors WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM assistants WHERE user_id = ?", args: [userId] },
    ],
    "write",
  );
  await purgeIndex().catch(() => {});
}

/**
 * Takes `chars` of the text an owner may add to their assistants today, only if they fit in what's
 * left: in one statement, so two uploads at once can't both take the last of it, and nothing is
 * counted when they don't fit. A function that gives them back (to the same day only), for a file
 * that isn't kept after all; null when they don't fit.
 */
async function takeDailyText(userId: string, limit: number, chars: number): Promise<(() => Promise<void>) | null> {
  const key = `assistant-chars:${userId}`;
  const max = limit > FREE_STORAGE_BYTES ? DAILY_TEXT_PAID : DAILY_TEXT_FREE;
  const t = now();
  const client = await db();
  const taken = await client.execute({
    sql: `INSERT INTO rate_limits (key, count, reset_at) SELECT ?, ?, ? WHERE ? <= ?
          ON CONFLICT(key) DO UPDATE SET
            count = (CASE WHEN reset_at < ? THEN 0 ELSE count END) + excluded.count,
            reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END
          WHERE (CASE WHEN reset_at < ? THEN 0 ELSE count END) + excluded.count <= ?
          RETURNING reset_at`,
    args: [key, chars, t + DAY, chars, max, t, t, t, max],
  });
  const day = taken.rows[0]?.reset_at;
  if (day === undefined || day === null) return null;
  return async () => {
    await client.execute({ sql: "UPDATE rate_limits SET count = MAX(0, count - ?) WHERE key = ? AND reset_at = ?", args: [chars, key, day] });
  };
}

type Upload = { name: unknown; kind: unknown; pages?: unknown; text: string };

/**
 * The first reason a file of `chars` characters, `stored` bytes counted and this hash can't be
 * added to the assistant now, in the order the editor shows them; null when it can.
 */
async function fileRefusal(userId: string, assistantId: string, chars: number, stored: number, hash: string, limit: number): Promise<Refusal | null> {
  const row = await one<{ owned: number; files: number; chars: number; same: number; used: number }>(
    `SELECT ${OWNED} AS owned,
            (SELECT COUNT(*) FROM assistant_files WHERE assistant_id = ?) AS files,
            (SELECT COALESCE(SUM(chars), 0) FROM assistant_files WHERE assistant_id = ?) AS chars,
            EXISTS (SELECT 1 FROM assistant_files WHERE assistant_id = ? AND hash = ?) AS same,
            ${USED_STORAGE_SQL} AS used`,
    [assistantId, userId, assistantId, assistantId, assistantId, hash, userId, userId],
  );
  if (!row || !Number(row.owned)) return { code: "not_found" };
  if (Number(row.files) >= MAX_ASSISTANT_FILES) return { code: "too_many_files", max: MAX_ASSISTANT_FILES };
  if (Number(row.chars) + chars > MAX_ASSISTANT_CHARS) return { code: "assistant_full", chars: MAX_ASSISTANT_CHARS };
  if (Number(row.same)) return { code: "duplicate" };
  if (Number(row.used) + stored > limit) return { code: "storage", used: Number(row.used), limit };
  return null;
}

// How long a failed upload waits before each new try at deleting what it stored, when the database
// didn't take the delete (a moment's outage).
const DROP_WAITS = [250, 1000];

/**
 * Deletes a file that isn't kept: what FILE_TABLES keeps for it first (its chunks' index rows go
 * with them), then its row, tried again after each of DROP_WAITS. False when even the last try
 * failed: the file is then listed with what was stored of it, for its owner to delete.
 */
async function dropFile(client: Client, assistantId: string, fileId: string): Promise<boolean> {
  for (const wait of [0, ...DROP_WAITS]) {
    if (wait) await new Promise((done) => setTimeout(done, wait));
    try {
      await client.batch(fileDeletes(assistantId, fileId), "write");
      return true;
    } catch {
      // Tried again, if there's a try left.
    }
  }
  return false;
}

/**
 * Adds a file's text to one of the user's assistants: refused with its reason when the text is
 * empty or over a limit (never cut), when the assistant has MAX_ASSISTANT_FILES or would go over
 * MAX_ASSISTANT_CHARS, when it already has the same text, when the owner's storage can't take
 * STORE_FACTOR times its bytes, or when they've added their day's text. The limits are checked
 * again in the statement that adds it. Then counted and stored in chunks with their index rows
 * (indexFile), and only then does the assistant get a new version. If storing fails, the file is
 * deleted (see dropFile) and the assistant keeps its version. The day's text is given back only
 * when nothing was written; a file whose chunks were being written uses it, kept or not.
 * `version` is the one the editor read: the file is added whatever it is. The file, and the version
 * the editor saves at next: the new one only when nothing else changed the assistant since its
 * version (versionAfter).
 */
export async function addAssistantFile(userId: string, assistantId: string, upload: Upload, version: number): Promise<{ file: AssistantFile; version: number }> {
  if (!isVersion(version)) refuse({ code: "bad_request" });
  if (!(await ownRow(userId, assistantId))) refuse({ code: "not_found" });
  if (!isFileKind(upload.kind)) refuse({ code: "bad_file" });
  const kind = upload.kind as AssistantFileKind;
  const text = typeof upload.text === "string" ? upload.text.replace(/\u0000/g, "") : "";
  if (!text.trim()) refuse({ code: "bad_file" });
  // The characters first: a UTF-8 character takes at most 3 bytes for each of its UTF-16 units, so
  // a text over MAX_UPLOAD_BYTES is over MAX_FILE_CHARS too, and that's its reason.
  if (text.length > MAX_FILE_CHARS) refuse({ code: "file_long", chars: MAX_FILE_CHARS });
  const bytes = utf8(text);
  if (bytes > MAX_UPLOAD_BYTES) refuse({ code: "upload_big", bytes: MAX_UPLOAD_BYTES });
  const name = cleanFileName(upload.name);
  const pages = Number.isSafeInteger(upload.pages) && (upload.pages as number) > 0 ? Math.min(upload.pages as number, 1_000_000) : 0;
  const stored = STORE_FACTOR * bytes;
  const hash = sha256(text);
  const limit = await storageLimit(userId);
  const problem = await fileRefusal(userId, assistantId, text.length, stored, hash, limit);
  if (problem) refuse(problem);

  // The day's text, taken before the file's tokens are counted, so a day's uploads are only ever
  // counted once. Given back only when the file's row isn't written (another upload took its place):
  // once it is, its chunks are written, and its characters stay spent whether the file is kept or
  // not (deleted while it's stored, or storing failed), or uploading and deleting again and again
  // would write without end.
  const giveBack = (await takeDailyText(userId, limit, text.length)) ?? refuse({ code: "daily_text" });
  let written = false;
  try {
    const { tokens, exact } = await fileTokens(text);
    const fileId = randomId();
    const client = await db();
    const added = await client.execute({
      sql: `INSERT INTO assistant_files (id, assistant_id, name, kind, pages, chars, bytes, stored, tokens, exact, cut, hash, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ${OWNED}
              AND (SELECT COUNT(*) FROM assistant_files WHERE assistant_id = ?) < ?
              AND (SELECT COALESCE(SUM(chars), 0) FROM assistant_files WHERE assistant_id = ?) + ? <= ?
              AND NOT EXISTS (SELECT 1 FROM assistant_files WHERE assistant_id = ? AND hash = ?)
              AND ${USED_STORAGE_SQL} + ? <= ?`,
      args: [
        fileId, assistantId, name, kind, pages, text.length, bytes, stored, tokens, exact ? 1 : 0, text.endsWith(CUT_NOTE) ? 1 : 0, hash, now(),
        assistantId, userId,
        assistantId, MAX_ASSISTANT_FILES,
        assistantId, text.length, MAX_ASSISTANT_CHARS,
        assistantId, hash,
        userId, userId, stored, limit,
      ],
    });
    // Another request got there first: say which limit it took.
    if (!added.rowsAffected) refuse((await fileRefusal(userId, assistantId, text.length, stored, hash, limit)) ?? { code: "failed" });
    written = true;
    // The new version once the file is all there, so an upload that fails leaves the assistant as
    // the editor read it, version and all.
    let next = version;
    try {
      await indexFile(assistantId, fileId, text, tokens);
      const done = await client.batch(
        [
          {
            sql: "UPDATE assistants SET version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM assistant_files WHERE id = ? AND assistant_id = ?)",
            args: [now(), assistantId, userId, fileId, assistantId],
          },
          { sql: "SELECT version FROM assistants WHERE id = ? AND user_id = ?", args: [assistantId, userId] },
        ],
        "write",
      );
      next = versionAfter(version, Number(done[1].rows[0]?.version ?? 0));
    } catch (err) {
      console.error("[flash] storing an assistant's file failed", err instanceof Error ? err.message : "error");
      // No new version.
      if (!(await dropFile(client, assistantId, fileId))) console.error("[flash] deleting an assistant's file that wasn't stored failed");
      await purgeIndex().catch(() => {});
      refuse({ code: "failed" });
    }
    const file = await one<FileRow>(`SELECT ${FILE_FIELDS} FROM assistant_files WHERE id = ?`, [fileId]);
    if (!file) return refuse({ code: "failed" });
    return { file: fileOf(file), version: next };
  } finally {
    if (!written) await giveBack().catch(() => {});
  }
}

/** A file's text as it was stored, its chunks in order; null when it isn't a file of the user's assistant. */
export async function assistantFileText(userId: string, assistantId: string, fileId: string): Promise<{ name: string; text: string } | null> {
  const file = await one<{ name: string }>(`SELECT name FROM assistant_files WHERE id = ? AND assistant_id = ? AND ${OWNED}`, [fileId, assistantId, assistantId, userId]);
  if (!file) return null;
  const chunks = await all<{ body: string }>("SELECT body FROM assistant_chunks WHERE assistant_id = ? AND file_id = ? ORDER BY seq", [assistantId, fileId]);
  return { name: file.name, text: chunks.map((c) => c.body).join("") };
}

/** Starts a chat with one of the user's assistants, named after it. Null when it isn't theirs. */
export async function startAssistantChat(userId: string, assistantId: string): Promise<{ id: string; name: string; updated_at: number; assistantId: string } | null> {
  const id = randomId();
  const at = now();
  const made = await (await db()).execute({
    sql: "INSERT INTO projects (id, user_id, name, updated_at, assistant_id) SELECT ?, user_id, name, ?, id FROM assistants WHERE id = ? AND user_id = ?",
    args: [id, at, assistantId, userId],
  });
  if (!made.rowsAffected) return null;
  const row = await one<{ name: string }>("SELECT name FROM projects WHERE id = ?", [id]);
  return { id, name: row?.name ?? "", updated_at: at, assistantId };
}
