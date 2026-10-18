/*
 * Assistants: a name, instructions, a few starters, a level for new chats and up to 20 files kept
 * as text, which answer from those files (see server/assistant-search.ts). Shared by the browser
 * (the editor and Import my GPT) and the server, so both refuse the same things the same way.
 *
 * Nothing about assistants reaches anyone while ASSISTANTS_ON is false: no route answers and the
 * chat ignores a chat's assistant, so nobody can be charged for one before its price line shows.
 */
import { isLevel, type Level } from "./levels.ts";
import { BRAND_NAME, LEGAL_NAME, PRODUCT_NAME } from "./product.ts";

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
 * the real factor and fails if it goes over (about 1.8 for text in any language), except for a
 * list of short codes (SKUs, vouchers), where every word is new and the index costs about as much
 * as the text: up to about 3.5, counted as 3 all the same. Storing costs no credits only while
 * search is the database's own full-text index: any embedding or paid call at upload would have to
 * charge.
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

// Control characters other than tabs and line breaks (C0, DEL and C1), and the marks that turn
// text around (bidirectional overrides and marks), which could make a name read as something else.
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// Letters that show as a blank (the Hangul fillers, a blank Braille cell): a space on one line.
const BLANK = /[\u115F\u1160\u2800\u3164\uFFA0]/g;

// The C1 line break (NEL) is a line break.
const text = (value: unknown) => (typeof value === "string" ? value.replace(/\r\n?|\u0085/g, "\n").replace(HIDDEN, "") : "");
const line = (value: unknown) => text(value).replace(BLANK, " ").replace(/\s+/g, " ").trim();

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

// Flash's own names, which an assistant can't take, compared without case, accents, spaces or
// punctuation, and with the letters that look like theirs: Cyrillic "а" for "a", Cherokee "Ꮪ" for
// "S", a small capital "ꜰ" for "f", "I" for "l". "™" and "℠" go the way "®" goes, before NFKC
// makes them the letters "TM" and "SM". So do the modifier letters NFKC leaves as they are, which
// look like punctuation: "ʼ" is an apostrophe, "ˈ" a quote, "ꓹ" a comma.
const nameKey = (name: string) =>
  name.replace(/[\u2120\u2122]/g, "").normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+|\p{Lm}+/gu, "");
// The letters and digits that look like each Latin letter, as nameKey leaves them: from Unicode's
// confusables.txt (10.0), the Latin letters with a stroke, hook or curl built in (from their
// names), and the Latin small capitals. Printed by scripts/lookalikes.ts.
const LOOKALIKES: Record<string, string> = {
  a: "\u{251}\u{3b1}\u{430}\u{15c5}\u{1d00}\u{1d8f}\u{2c65}\u{a4ee}\u{ab7a}\u{102a0}\u{16f40}",
  b: "\u{180}\u{183}\u{185}\u{253}\u{299}\u{3b2}\u{431}\u{432}\u{44c}\u{463}\u{48d}\u{13fc}\u{15af}\u{15f7}\u{1d6c}\u{1d80}\u{a4d0}\u{a797}\u{a7b5}\u{ab9f}\u{10282}\u{102a1}\u{10301}",
  c: "\u{188}\u{23c}\u{255}\u{3c2}\u{3c3}\u{3db}\u{441}\u{4ab}\u{1d04}\u{2ca5}\u{a4da}\u{a793}\u{a794}\u{abaf}\u{102a2}\u{10302}\u{1043d}\u{1051c}\u{118e9}\u{118f2}\u{1df1d}",
  d: "\u{f0}\u{111}\u{18c}\u{221}\u{256}\u{257}\u{501}\u{146f}\u{15de}\u{15ea}\u{1d05}\u{1d6d}\u{1d81}\u{1d91}\u{a4d2}\u{a4d3}\u{a7c8}\u{ab70}\u{abb7}",
  e: "\u{247}\u{3b5}\u{435}\u{4bd}\u{4bf}\u{1d07}\u{1d92}\u{2c78}\u{2d39}\u{a4f0}\u{ab32}\u{ab34}\u{ab7c}\u{10286}\u{118c6}\u{118ce}",
  f: "\u{192}\u{3dd}\u{493}\u{584}\u{15b4}\u{1d6e}\u{1d82}\u{1e9d}\u{a4dd}\u{a730}\u{a799}\u{ab35}\u{10287}\u{102a5}\u{10525}\u{118c2}",
  g: "\u{18d}\u{1e5}\u{260}\u{261}\u{262}\u{29b}\u{50d}\u{581}\u{13fb}\u{1d83}\u{a4d6}\u{a7a1}\u{ab90}",
  h: "\u{127}\u{266}\u{29c}\u{3b7}\u{43d}\u{45b}\u{4a3}\u{4bb}\u{4c8}\u{4ca}\u{570}\u{13fa}\u{157c}\u{2c68}\u{2c8f}\u{a4e7}\u{a695}\u{a795}\u{ab8b}\u{ab92}\u{102cf}\u{104f5}",
  i: "1l\u{131}\u{142}\u{19a}\u{1c0}\u{234}\u{268}\u{269}\u{26a}\u{26b}\u{26c}\u{26d}\u{29f}\u{3b9}\u{456}\u{4cf}\u{5d5}\u{5df}\u{627}\u{661}\u{673}\u{6f1}\u{7ca}\u{14aa}\u{16c1}\u{1d0c}\u{1d7b}\u{1d7c}\u{1d85}\u{1d96}\u{2c61}\u{2c93}\u{2cd1}\u{2d4f}\u{a4e1}\u{a4f2}\u{a647}\u{a749}\u{a78e}\u{ab37}\u{ab38}\u{ab39}\u{ab75}\u{abae}\u{1028a}\u{10309}\u{10320}\u{10443}\u{10526}\u{118c3}\u{118d2}\u{16f16}\u{16f28}\u{1df04}\u{1df11}\u{1df13}\u{1df1a}\u{1e8c7}",
  j: "\u{249}\u{25f}\u{284}\u{29d}\u{3f3}\u{458}\u{148d}\u{1d0a}\u{a4d9}\u{ab7b}",
  k: "\u{199}\u{3ba}\u{43a}\u{49b}\u{49f}\u{16d5}\u{1d0b}\u{1d84}\u{2c6a}\u{2c95}\u{a4d7}\u{a741}\u{a743}\u{a745}\u{a7a3}\u{abb6}\u{10518}",
  l: "1i\u{131}\u{142}\u{19a}\u{1c0}\u{234}\u{268}\u{269}\u{26a}\u{26b}\u{26c}\u{26d}\u{29f}\u{3b9}\u{456}\u{4cf}\u{5d5}\u{5df}\u{627}\u{661}\u{673}\u{6f1}\u{7ca}\u{14aa}\u{16c1}\u{1d0c}\u{1d7b}\u{1d7c}\u{1d85}\u{1d96}\u{2c61}\u{2c93}\u{2cd1}\u{2d4f}\u{a4e1}\u{a4f2}\u{a647}\u{a749}\u{a78e}\u{ab37}\u{ab38}\u{ab39}\u{ab75}\u{abae}\u{1028a}\u{10309}\u{10320}\u{10443}\u{10526}\u{118c3}\u{118d2}\u{16f16}\u{16f28}\u{1df04}\u{1df11}\u{1df13}\u{1df1a}\u{1e8c7}",
  m: "\u{271}\u{3bc}\u{3fb}\u{43c}\u{4ce}\u{15f0}\u{16d6}\u{1d0d}\u{1d6f}\u{1d86}\u{2c99}\u{a4df}\u{ab3a}\u{ab87}\u{102b0}\u{10311}",
  n: "\u{19e}\u{235}\u{272}\u{273}\u{274}\u{3b7}\u{3bd}\u{43f}\u{578}\u{57c}\u{1260}\u{144e}\u{1d70}\u{1d87}\u{2c9b}\u{a4e0}\u{a4f5}\u{a791}\u{a7a5}\u{ab3b}\u{10513}",
  o: "0\u{f8}\u{275}\u{3b8}\u{3bf}\u{3c3}\u{43e}\u{473}\u{4e9}\u{585}\u{5e1}\u{647}\u{665}\u{6be}\u{6c1}\u{6d5}\u{6f5}\u{6ff}\u{7c0}\u{966}\u{9e6}\u{a66}\u{ae6}\u{b20}\u{b66}\u{be6}\u{c66}\u{ce6}\u{d20}\u{d66}\u{e50}\u{ed0}\u{1010}\u{101d}\u{1040}\u{10ff}\u{12d0}\u{1d0f}\u{1d11}\u{2c7a}\u{2c9f}\u{2d31}\u{2d41}\u{2d54}\u{3007}\u{a4f3}\u{a74b}\u{a74d}\u{ab3d}\u{ab3e}\u{ab74}\u{ab8e}\u{abbb}\u{10292}\u{102ab}\u{1042c}\u{104ea}\u{10516}\u{114d0}\u{118c8}\u{118d5}\u{118d7}\u{118e0}\u{1df1b}",
  p: "\u{1a5}\u{3c1}\u{440}\u{146d}\u{1d18}\u{1d29}\u{1d71}\u{1d7d}\u{1d88}\u{2ca3}\u{a4d1}\u{a751}\u{a753}\u{a755}\u{abb2}\u{10295}",
  q: "\u{24b}\u{2a0}\u{51b}\u{563}\u{566}\u{2d55}\u{a757}\u{a759}\u{a7af}",
  r: "\u{24d}\u{27c}\u{27d}\u{27e}\u{280}\u{433}\u{493}\u{1587}\u{1d26}\u{1d72}\u{1d73}\u{1d89}\u{2c85}\u{a4e3}\u{a7a7}\u{ab46}\u{ab47}\u{ab48}\u{ab49}\u{ab71}\u{ab81}\u{aba2}\u{104dc}\u{16f35}\u{1df16}",
  s: "\u{1bd}\u{23f}\u{282}\u{455}\u{57f}\u{1d74}\u{1d8a}\u{a4e2}\u{a731}\u{a7a9}\u{a7ca}\u{aba5}\u{abaa}\u{10296}\u{10448}\u{118c1}\u{16f3a}\u{1df1e}",
  t: "\u{167}\u{1ab}\u{1ad}\u{236}\u{288}\u{3c4}\u{442}\u{4ad}\u{1d1b}\u{1d75}\u{2c66}\u{2ca7}\u{a4d4}\u{ab72}\u{10297}\u{102b1}\u{10315}\u{118dc}\u{16f0a}\u{1df09}",
  u: "\u{289}\u{28b}\u{3c5}\u{57d}\u{1200}\u{144c}\u{1d1c}\u{1d7e}\u{1d99}\u{a4f4}\u{a79f}\u{a7b9}\u{ab4e}\u{ab52}\u{ab9c}\u{104f6}\u{118d8}\u{16f42}",
  v: "\u{28b}\u{3bd}\u{475}\u{5d8}\u{667}\u{6f7}\u{142f}\u{1d20}\u{1d8c}\u{2c71}\u{2c74}\u{2d38}\u{a4e6}\u{a6df}\u{a75f}\u{aba9}\u{1051d}\u{11706}\u{118c0}\u{16f08}",
  w: "\u{26f}\u{461}\u{47d}\u{51d}\u{561}\u{15ef}\u{1d21}\u{2c73}\u{a4ea}\u{a761}\u{ab83}\u{ab97}\u{aba4}\u{114c5}\u{1170a}\u{1170e}\u{1170f}\u{118e6}\u{118ef}",
  x: "\u{3c7}\u{445}\u{4b3}\u{1541}\u{157d}\u{16b7}\u{1d8d}\u{2cad}\u{2d5d}\u{a4eb}\u{ab53}\u{ab55}\u{ab56}\u{ab57}\u{ab58}\u{ab59}\u{10290}\u{102b4}\u{10317}\u{10322}\u{10527}\u{118ec}",
  y: "\u{1b4}\u{24f}\u{263}\u{28f}\u{3b3}\u{3c5}\u{433}\u{443}\u{493}\u{4af}\u{4b1}\u{10e7}\u{14a5}\u{1d8c}\u{1eff}\u{2c85}\u{2ca9}\u{a4ec}\u{ab5a}\u{ab79}\u{ab81}\u{ab8d}\u{102b2}\u{118c4}\u{118dc}\u{16f07}\u{16f43}",
  z: "\u{1b6}\u{225}\u{240}\u{290}\u{291}\u{3b6}\u{1d22}\u{1d76}\u{1d8e}\u{2c6c}\u{a4dc}\u{ab93}\u{102f5}\u{118c4}\u{118c9}\u{118e5}",
};
// Flash's names, alone or with words that make them read as Flash's own help or company, before
// or after, one or many, each also with an s, and the name too, as in "Flash's": "Flash support",
// "Official Flash ∞ AI", "AI-Flash Inc. Support", "Flash Customer Support", "Contact Flash Admins",
// "Flash's Help Desk". Only those: "flash" is an everyday word, and "Flash sale helper" or
// "Flashcards support" are someone's own.
const OWN = ["Flash", PRODUCT_NAME, BRAND_NAME, LEGAL_NAME, "AI-Flash"];
const ROLES = [
  "support", "team", "official", "help", "desk", "admin", "administrator", "moderator", "staff", "customer", "service", "contact", "billing",
  "account", "security", "assistant", "bot", "inc", "incorporated", "ltd", "llc", "corp", "corporation", "hq",
];
const alike = (names: string[]) => names.map((name) => [...nameKey(name)].map((ch) => `[${ch}${LOOKALIKES[ch] ?? ""}]`).join("")).join("|");
const ROLE = `(?:${alike(ROLES)})(?:${alike(["s"])})?`;
const KEPT = new RegExp(`^(?:${ROLE})*(?:${alike(OWN)})(?:${alike(["s"])})?(?:${ROLE})*$`, "u");

/** Whether a name is one Flash keeps for itself ("Flash support", "FLASH ∞ AI", "flash-team", "Flаsh" with a Cyrillic "а"). */
export const isKeptName = (name: string) => KEPT.test(nameKey(name));

// Something that shows: not only invisible characters (zero-width ones, joiners, soft hyphens,
// tags), marks or blanks.
const SHOWS = /[^\p{Default_Ignorable_Code_Point}\p{M}\s\u2800]/u;

/** The first reason these fields can't be saved, or null when they can. */
export function validateAssistant(a: AssistantFields): AssistantProblem | null {
  if (!SHOWS.test(a.name)) return { code: "name_missing" };
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
