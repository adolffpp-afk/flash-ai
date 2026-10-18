/*
 * What an assistant adds to a message, in credits, to show before it's sent (the line above the
 * composer, the editor's level, the import, the shared page), and the limits on other people's use
 * of one. Nothing new is charged: a message with an assistant is held and settled as any other, and
 * the hold counts its instructions and passages as part of what the message reads (see the chat
 * route). Pure, for the browser and the server: the levels' models are passed in (LEVEL_MODELS in
 * engines/claude.ts on the server, which the browser doesn't load).
 *
 * addOn(level) = ceil((fixed words + instructions + files) × rate(level) / 1e6 × MARKUP):
 *  - the fixed words are SECTION_BYTES (a token is never shorter than a byte), and the name and
 *    instructions are instr_tokens, the largest count over every level's model;
 *  - the files are every file's tokens when they're read whole (each with its title and what wraps it),
 *    else the most a message reads, PASSAGE_TOKENS, with what wraps each of MAX_PASSAGES passages;
 *  - rate(level) is the dearer of the level's model's input rates, so Sonic's is its model's rate for
 *    prompts over 100,000 tokens and the figure holds in a long chat; Auto's is Vision's, as Auto
 *    never picks Summit; Research on Sonic runs on Ascend (see claudeChoice), so its figure is Ascend's.
 * It counts one read: a reply that looks something up (Research, the forecast) reads them again
 * at each step, and the hold pays for that.
 *
 * about(level) is the whole message, about: the same tokens at the model's usual rate, and a typical
 * reply on that level (TYPICAL_CREDITS, scaled as the chat route scales it).
 */
import { MARKUP, TYPICAL_CREDITS, claudePrice } from "./credits.ts";
import { MAX_PASSAGES, PASSAGE_TOKENS } from "./assistants.ts";
import { LEVELS, type Level, type ModelLevel } from "./levels.ts";
import type { Engine } from "./types.ts";
import { PASSAGE_CONTEXT, SECTION_BYTES } from "./assistant-prompt.ts";

// Other people's use of an assistant: a reply writes at most this many tokens (they can ask it to
// continue), and each person sends one at most this many messages a day.
export const VISITOR_REPLY_TOKENS = 2000;
export const VISITOR_DAILY_MESSAGES = 200;

// An allowance for what wraps each passage as Claude reads it (its document's tags), which no count
// of its text shows.
export const PASSAGE_FRAMING_TOKENS = 50;

export type CostFile = { name: string; tokens: number; exact: boolean };
/** What an assistant's price comes from: its instructions' tokens (instr_tokens) and its files. */
export type CostInput = { instrTokens: number; files: CostFile[] };
export type LevelModels = Record<ModelLevel, string>;

const bytes = (text: string) => new TextEncoder().encode(text).length;
// What each passage adds to its text: what it's said to be, and what wraps it.
const PASSAGE_OVERHEAD = bytes(PASSAGE_CONTEXT) + PASSAGE_FRAMING_TOKENS;
// A file read whole is titled by its name, or "File 2" when names aren't shown: the longer counts.
const titleBytes = (f: CostFile, i: number) => Math.max(bytes(f.name), bytes(`File ${i + 1}`));

// Every file's tokens with its title, each title as `title` measures it.
const wholeSum = (files: CostFile[], title: (f: CostFile, i: number) => number) => files.reduce((sum, f, i) => sum + f.tokens + title(f, i) + 1, 0);

/**
 * Whether every message reads every file whole: each counted exactly, and all of them, with their
 * titles, within PASSAGE_TOKENS, as passagesFor decides (see server/assistant-search.ts), whichever
 * way they're titled.
 */
export function readWhole(files: CostFile[]): boolean {
  return files.length > 0 && files.every((f) => f.exact) && wholeSum(files, titleBytes) <= PASSAGE_TOKENS;
}

/**
 * The most a message reads from an assistant's files, in tokens: 0 without any. Files read whole
 * are their real total. Otherwise the most a search reads, or, when they're read whole one way
 * they're titled and not the other, the larger of that and the real total (whole, there can be more
 * than MAX_PASSAGES of them).
 */
export function fileTokens(files: CostFile[]): number {
  if (!files.length) return 0;
  const whole = wholeSum(files, titleBytes) + files.length * PASSAGE_OVERHEAD;
  if (readWhole(files)) return whole;
  const most = PASSAGE_TOKENS + MAX_PASSAGES * PASSAGE_OVERHEAD;
  const shortest = (f: CostFile, i: number) => Math.min(bytes(f.name), bytes(`File ${i + 1}`));
  return files.every((f) => f.exact) && wholeSum(files, shortest) <= PASSAGE_TOKENS ? Math.max(most, whole) : most;
}

/** The most a message reads for an assistant, in tokens: Flash's words about it, its instructions and its files. */
export const assistantTokens = (a: CostInput) => SECTION_BYTES + Math.max(0, a.instrTokens) + fileTokens(a.files);

/** The level a message is priced at: Auto's figure is Vision's, and Research on Sonic runs on Ascend. */
export function pricedLevel(level: Level, engine: Engine = "text"): ModelLevel {
  const at: ModelLevel = level === "auto" ? "vision" : level;
  return engine === "search" && at === "sonic" ? "ascend" : at;
}

/** A model's dearest input rate, in cents a million tokens: the long-prompt rate when it has one. */
export const inputRate = (model: string) => Math.max(claudePrice(model).input, claudePrice(model, Number.MAX_SAFE_INTEGER).input);

// Credits for this many cents, rounded up: a sum that is a whole number of credits isn't pushed over it by rounding.
const creditsUp = (cents: number) => Math.ceil(cents * MARKUP - 1e-9);

/** The most an assistant adds to a message on a level, in credits (see the formula above). */
export function addOn(level: Level, a: CostInput, models: LevelModels, engine: Engine = "text"): number {
  return creditsUp((assistantTokens(a) * inputRate(models[pricedLevel(level, engine)])) / 1e6);
}

/** A typical written reply on a level, in credits, as the chat route scales it from Ascend's (see TYPICAL_CREDITS). */
export function typicalReply(level: Level, models: LevelModels): number {
  const scale = claudePrice(models[pricedLevel(level)]).output / claudePrice(models.ascend).output;
  return Math.max(1, Math.round((TYPICAL_CREDITS.text ?? 4) * scale));
}

/** About what a message with the assistant costs on a level, in credits: its instructions and files, and a typical reply. */
export function about(level: Level, a: CostInput, models: LevelModels): number {
  return creditsUp((assistantTokens(a) * claudePrice(models[pricedLevel(level)]).input) / 1e6) + typicalReply(level, models);
}

/** addOn and about for every level, Auto first. */
export function levelCosts(a: CostInput, models: LevelModels): { addOn: Record<Level, number>; about: Record<Level, number> } {
  const ids = LEVELS.map((l) => l.id);
  return {
    addOn: Object.fromEntries(ids.map((id) => [id, addOn(id, a, models)])) as Record<Level, number>,
    about: Object.fromEntries(ids.map((id) => [id, about(id, a, models)])) as Record<Level, number>,
  };
}
