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
 */
import { randomBytes } from "node:crypto";
import type { InStatement } from "@libsql/client";
import { all, db, now, one } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { countOf, overLimit } from "./limits.ts";
import { FREE_STORAGE_BYTES, USED_STORAGE_SQL, storageLimit, usedStorage } from "./site-files.ts";
import { indexFile, purgeIndex, removeFileRows } from "./assistant-search.ts";
import { LEVEL_MODELS, countTextTokens } from "../engines/claude.ts";
import { CUT_NOTE } from "../office.ts";
import type { Level } from "../levels.ts";
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
 * Every table that keeps something for an assistant by its assistant_id, deleted with it. A test
 * checks every table with an assistant_id column is here, except projects: a chat started with an
 * assistant keeps its messages when the assistant goes (its next message is refused instead).
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
 * message on any level pays for them. Their UTF-8 bytes when counting fails, which a count never
 * goes over. 0 for none.
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
 * Chinese tail look small. Never more than its bytes, which a count never goes over, and its bytes
 * when counting fails.
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

const assistantCount = async (userId: string) => Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM assistants WHERE user_id = ?", [userId]))?.n ?? 0);
const unique = (err: unknown) => err instanceof Error && /UNIQUE/i.test(err.message);

/**
 * Makes an assistant for the user from what was sent (cleaned, then refused with its reason if
 * over a limit), with a colour of its own if none was picked. Refused once the user has
 * MAX_ASSISTANTS. Its id is new and starts with 16 digits no other assistant's does, so its words
 * are tagged as its own (see tagOf in assistant-chunks.ts); an id whose 16 are taken is made again.
 * `newId` is for tests.
 */
export async function createAssistant(userId: string, input: unknown, o: { newId?: () => string } = {}): Promise<Assistant> {
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
 * the refusal carries its version now. A change gives it a new version; sending what it already
 * has changes nothing. Its instructions are counted again when its name or instructions change.
 */
export async function updateAssistant(userId: string, id: string, patch: unknown, version: number): Promise<Assistant> {
  if (!Number.isSafeInteger(version) || version < 0) refuse({ code: "bad_request" });
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
 * Deletes one file of the user's assistant, its chunks and their index rows with it (see
 * removeFileRows), and gives the assistant a new version. The new version, or null when there's no
 * such file of theirs.
 */
export async function deleteAssistantFile(userId: string, assistantId: string, fileId: string): Promise<number | null> {
  const found = await one(`SELECT 1 FROM assistant_files WHERE id = ? AND assistant_id = ? AND ${OWNED}`, [fileId, assistantId, assistantId, userId]);
  if (!found) return null;
  const done = await (await db()).batch(
    [
      ...removeFileRows(userId, assistantId, fileId),
      { sql: "UPDATE assistants SET updated_at = ? WHERE id = ? AND user_id = ?", args: [now(), assistantId, userId] },
      { sql: "SELECT version FROM assistants WHERE id = ? AND user_id = ?", args: [assistantId, userId] },
    ],
    "write",
  );
  await purgeIndex().catch(() => {});
  const row = done.at(-1)!.rows[0];
  return row ? Number(row.version) : null;
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

/** The text an owner may still add to their assistants today, and how much they may add in a day. */
async function dailyRoom(userId: string, limit: number): Promise<{ key: string; max: number; left: number }> {
  const key = `assistant-chars:${userId}`;
  const max = limit > FREE_STORAGE_BYTES ? DAILY_TEXT_PAID : DAILY_TEXT_FREE;
  return { key, max, left: max - (await countOf(key)) };
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

/**
 * Adds a file's text to one of the user's assistants: refused with its reason when the text is
 * empty or over a limit (never cut), when the assistant has MAX_ASSISTANT_FILES or would go over
 * MAX_ASSISTANT_CHARS, when it already has the same text, when the owner's storage can't take
 * STORE_FACTOR times its bytes, or when they've added their day's text. The limits are checked
 * again in the statement that adds it. Then counted and stored in chunks with their index rows
 * (indexFile); if that fails, the file is deleted. The file, and the assistant's new version.
 */
export async function addAssistantFile(userId: string, assistantId: string, upload: Upload): Promise<{ file: AssistantFile; version: number }> {
  if (!(await ownRow(userId, assistantId))) refuse({ code: "not_found" });
  if (!isFileKind(upload.kind)) refuse({ code: "bad_file" });
  const kind = upload.kind as AssistantFileKind;
  const text = typeof upload.text === "string" ? upload.text.replace(/\u0000/g, "") : "";
  if (!text.trim()) refuse({ code: "bad_file" });
  const bytes = utf8(text);
  if (bytes > MAX_UPLOAD_BYTES) refuse({ code: "upload_big", bytes: MAX_UPLOAD_BYTES });
  if (text.length > MAX_FILE_CHARS) refuse({ code: "file_long", chars: MAX_FILE_CHARS });
  const name = cleanFileName(upload.name);
  const pages = Number.isSafeInteger(upload.pages) && (upload.pages as number) > 0 ? Math.min(upload.pages as number, 1_000_000) : 0;
  const stored = STORE_FACTOR * bytes;
  const hash = sha256(text);
  const limit = await storageLimit(userId);
  const problem = await fileRefusal(userId, assistantId, text.length, stored, hash, limit);
  if (problem) refuse(problem);

  // The day's text, counted before the file's tokens are, so a day's uploads are only ever counted once.
  const day = await dailyRoom(userId, limit);
  if (text.length > day.left || (await overLimit(day.key, day.max, DAY, text.length))) refuse({ code: "daily_text" });

  const { tokens, exact } = await fileTokens(text);
  const fileId = randomId();
  const at = now();
  const client = await db();
  const added = await client.batch(
    [
      {
        sql: `INSERT INTO assistant_files (id, assistant_id, name, kind, pages, chars, bytes, stored, tokens, exact, cut, hash, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ${OWNED}
                AND (SELECT COUNT(*) FROM assistant_files WHERE assistant_id = ?) < ?
                AND (SELECT COALESCE(SUM(chars), 0) FROM assistant_files WHERE assistant_id = ?) + ? <= ?
                AND NOT EXISTS (SELECT 1 FROM assistant_files WHERE assistant_id = ? AND hash = ?)
                AND ${USED_STORAGE_SQL} + ? <= ?`,
        args: [
          fileId, assistantId, name, kind, pages, text.length, bytes, stored, tokens, exact ? 1 : 0, text.endsWith(CUT_NOTE) ? 1 : 0, hash, at,
          assistantId, userId,
          assistantId, MAX_ASSISTANT_FILES,
          assistantId, text.length, MAX_ASSISTANT_CHARS,
          assistantId, hash,
          userId, userId, stored, limit,
        ],
      },
      {
        sql: "UPDATE assistants SET version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM assistant_files WHERE id = ? AND assistant_id = ?)",
        args: [at, assistantId, userId, fileId, assistantId],
      },
      { sql: "SELECT version FROM assistants WHERE id = ? AND user_id = ?", args: [assistantId, userId] },
    ],
    "write",
  );
  // Another request got there first: say which limit it took.
  if (!added[0].rowsAffected) refuse((await fileRefusal(userId, assistantId, text.length, stored, hash, limit)) ?? { code: "failed" });
  try {
    await indexFile(assistantId, fileId, text, tokens);
  } catch (err) {
    console.error("[flash] storing an assistant's file failed", err instanceof Error ? err.message : "error");
    await client.batch(removeFileRows(userId, assistantId, fileId), "write").catch(() => {});
    await purgeIndex().catch(() => {});
    refuse({ code: "failed" });
  }
  const file = await one<FileRow>(`SELECT ${FILE_FIELDS} FROM assistant_files WHERE id = ?`, [fileId]);
  return { file: file ? fileOf(file) : refuse({ code: "failed" }), version: Number(added[2].rows[0]?.version ?? 0) };
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
