/*
 * Assistants: a name, instructions, a few starters, a level for new chats and up to 20 files kept
 * as text, which answer from those files (see server/assistant-search.ts). Shared by the browser
 * (the editor and Import my GPT) and the server, so both refuse the same things the same way.
 *
 * Nothing about assistants reaches anyone while ASSISTANTS_ON is false: no route answers and the
 * chat ignores a chat's assistant, so nobody can be charged for one before its price line shows.
 */
import { isLevel, type Level } from "./levels.ts";
import { BRAND_NAME, LEGAL_NAME, PRODUCT_NAME, TRADEMARK } from "./product.ts";

export const ASSISTANTS_ON = false;

// Limits. Text over one is refused with its reason, never cut.
export const MAX_ASSISTANTS = 50;
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 300;
// The limit GPTs have, so instructions copied from one always fit.
export const MAX_ASSISTANT_INSTRUCTIONS = 8000;
export const MAX_STARTERS = 6;
export const MAX_STARTER_CHARS = 200;
export const MAX_ASSISTANT_FILES = 20;
export const MAX_FILE_CHARS = 1_000_000;
export const MAX_ASSISTANT_CHARS = 2_000_000;
// One file's text as uploaded, in UTF-8 bytes: room for 1,000,000 characters of most languages.
export const MAX_UPLOAD_BYTES = 3_000_000;

// What one message reads from an assistant's files: up to this many tokens on every level, in at
// most this many passages, from chunks of about this many characters.
export const PASSAGE_TOKENS = 6000;
export const MAX_PASSAGES = 8;
export const CHUNK_CHARS = 1200;

// Free models get less: the instructions up to this many characters, and passages up to this many.
export const FREE_INSTRUCTION_CHARS = 8_000;
export const FREE_PASSAGE_CHARS = 6_000;

/*
 * An assistant's text takes more room in the database than its own bytes: its chunks, plus the
 * search index, which keeps no copy of the text. Each file counts STORE_FACTOR times its UTF-8
 * bytes against the owner's storage (see storageLimit in server/site-files.ts). A test measures
 * the real factor and fails if it goes over. Storing costs no credits only while search is the
 * database's own full-text index: any embedding or paid call at upload would have to charge.
 */
export const STORE_FACTOR = 3;

/** How an assistant's files are searched on this database: its full-text index, or the slower fallback. */
export type SearchMode = "index" | "fallback";

// The avatar is one of these colours with the name's first letter.
export const ASSISTANT_COLORS = ["teal", "violet", "amber", "rose", "sky", "lime"] as const;

export type AssistantFields = {
  name: string;
  description: string;
  instructions: string;
  starters: string[];
  level: Level;
  color: string;
};

/**
 * Why an assistant can't be saved as it is, as a code with its numbers; the words are chosen where
 * it's shown.
 */
export type AssistantProblem =
  | { code: "name_missing" }
  | { code: "name_long"; max: number }
  | { code: "name_kept" }
  | { code: "description_long"; max: number }
  | { code: "instructions_long"; max: number; count: number }
  | { code: "starters"; max: number; chars: number };

// Control characters other than tabs and line breaks, and the marks that turn text around
// (bidirectional overrides), which could make a name read as something else.
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(HIDDEN, "") : "");
const line = (value: unknown) => text(value).replace(/\s+/g, " ").trim();

/**
 * An assistant's fields from what was sent: text only, without hidden characters, names and
 * starters on one line, and a level and colour Flash knows. Nothing is cut: too long is refused
 * by validateAssistant.
 */
export function cleanAssistant(input: unknown): AssistantFields {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const starters = Array.isArray(o.starters) ? o.starters : typeof o.starters === "string" ? o.starters.split("\n") : [];
  return {
    name: line(o.name),
    description: line(o.description),
    instructions: text(o.instructions).trim(),
    starters: [...new Set(starters.map(line).filter(Boolean))],
    level: isLevel(o.level) ? o.level : "auto",
    color: (ASSISTANT_COLORS as readonly unknown[]).includes(o.color) ? (o.color as string) : "",
  };
}

// Flash's own names, which an assistant can't take, compared without case, spaces or punctuation.
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const KEPT_NAMES = new Set(
  ["Flash", "Flash support", "Flash team", "Flash official", PRODUCT_NAME, BRAND_NAME, LEGAL_NAME, TRADEMARK].map(nameKey),
);

/** Whether a name is one Flash keeps for itself ("Flash support", "FLASH ∞ AI", "flash-team"). */
export const isKeptName = (name: string) => KEPT_NAMES.has(nameKey(name));

/** The first reason these fields can't be saved, or null when they can. */
export function validateAssistant(a: AssistantFields): AssistantProblem | null {
  if (!a.name) return { code: "name_missing" };
  if (a.name.length > MAX_NAME) return { code: "name_long", max: MAX_NAME };
  if (isKeptName(a.name)) return { code: "name_kept" };
  if (a.description.length > MAX_DESCRIPTION) return { code: "description_long", max: MAX_DESCRIPTION };
  if (a.instructions.length > MAX_ASSISTANT_INSTRUCTIONS) {
    return { code: "instructions_long", max: MAX_ASSISTANT_INSTRUCTIONS, count: a.instructions.length };
  }
  if (a.starters.length > MAX_STARTERS || a.starters.some((s) => s.length > MAX_STARTER_CHARS)) {
    return { code: "starters", max: MAX_STARTERS, chars: MAX_STARTER_CHARS };
  }
  return null;
}
