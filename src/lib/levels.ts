import { msg } from "./i18n.ts";
import type { Engine } from "./types.ts";
import { messageWindow } from "./message-window.ts";

/*
 * Flash's levels of intelligence: one workspace, four levels, and Auto, which picks the level for
 * each request so people who'd rather not choose get the right mix of quality, speed and cost.
 * Each level runs on a Claude model (see LEVEL_MODELS in engines/claude.ts), and credits follow
 * what the model really costs, so a quick answer on Sonic uses a fraction of a Summit one.
 * The names still need a trademark lawyer's clearance before Flash is marketed widely.
 */
export const LEVELS = [
  { id: "auto", name: "Auto", short: msg("Auto"), blurb: msg("Flash picks the best model for each request") },
  { id: "sonic", name: "Flash Sonic", short: "Sonic", blurb: msg("Fastest, and lightest on credits. For quick answers") },
  { id: "ascend", name: "Flash Ascend", short: "Ascend", blurb: msg("Smart and quick. For everyday writing and research") },
  { id: "vision", name: "Flash Vision", short: "Vision", blurb: msg("Thinks deeper. For apps, code and hard problems") },
  // The top level keeps the id "ultra"; "Flash Ultra" was renamed because it echoes Google's Gemini Ultra and AI Ultra.
  { id: "ultra", name: "Flash Summit", short: "Summit", blurb: msg("Flash's most capable level, for the hardest work. Uses more credits") },
] as const;

export type Level = (typeof LEVELS)[number]["id"];
export type ModelLevel = Exclude<Level, "auto">;

/*
 * OpenAI's ChatGPT models, picked by name in the same menu as the levels, for writing, code,
 * translation and documents (GPT_ENGINES in engines/openai-chat.ts). Auto uses them only as
 * AUTO_GPT says, and the menu shows them only when the server has an OpenAI key. Credits follow
 * what each answer costs, as for a level.
 */
export const GPT_PICKS = [
  { id: "gpt-sol", name: "GPT-6.1 Sol", short: "Sol", blurb: msg("OpenAI's model for writing, code and hard questions") },
  { id: "gpt-luna", name: "GPT-6 Luna", short: "Luna", blurb: msg("OpenAI's fast model, lightest on credits") },
] as const;

export type GptPick = (typeof GPT_PICKS)[number]["id"];

/*
 * The ChatGPT model Auto may use for each level it picks. Each level scored higher than the ChatGPT
 * model at its price on most published tests (Sonic and Luna, Ascend and Sol, October 2026), so Auto
 * keeps the level, except:
 * - peer: the ChatGPT model at the same price answers when it costs at most half as much for this
 *   request (see muchCheaper in engines/openai-chat.ts): Sonic's price goes up past 100,000 tokens
 *   and Luna's only past 272,000, so a long chat's quick answer goes to Luna. (Sol costs Ascend's
 *   price or more, so Ascend has none.)
 * - backup: the ChatGPT model that answers when the level is busy or down, so the request still gets
 *   an answer. Vision's is Sol, the strongest ChatGPT model, at half Vision's price.
 * Either only on an engine and request a ChatGPT model can answer (see gptBlock in the chat route).
 */
export const AUTO_GPT: Record<ModelLevel, { peer?: GptPick; backup?: GptPick }> = {
  sonic: { peer: "gpt-luna", backup: "gpt-luna" },
  ascend: { backup: "gpt-sol" },
  vision: { backup: "gpt-sol" },
  ultra: {},
};
/** What the Intelligence menu can hold: Auto, a level or a ChatGPT model. */
export type ModelPick = Level | GptPick;

export const isLevel = (value: unknown): value is Level => LEVELS.some((l) => l.id === value);
export const isGptPick = (value: unknown): value is GptPick => GPT_PICKS.some((g) => g.id === value);
export const isModelPick = (value: unknown): value is ModelPick => isLevel(value) || isGptPick(value);
export const levelName = (level: ModelPick) => [...LEVELS, ...GPT_PICKS].find((l) => l.id === level)!.name;

/** The engines that run on Claude, where a level applies. Pictures, video, music and voice have their own models. */
export const LEVEL_ENGINES: readonly Engine[] = ["text", "search", "code", "translate", "docs", "app", "slides"];

// Asked for in so many words: careful, step by step, in depth.
const DEEP =
  /\b(think (it )?(hard|harder|deeply|carefully|through)|step[- ]by[- ]step|in[- ]depth|thorough(ly)?|rigorous(ly)?|prove|proof|derive|detailed (analysis|plan|report|breakdown)|business plan|strategy|due diligence|financial model|thesis|dissertation|research paper)\b/i;
// Work that needs more than a quick answer, however short the request.
const WORK =
  /\b(write|draft|rewrite|compose|create|make|build|design|plan|explain|analy[sz]e|compare|summari[sz]e|review|edit|improve|fix|translate|list|outline|essay|story|poem|lyrics|letter|e-?mail|report|article|blog|post|speech|script|resume|cv|cover letter|proposal|code|function|recipe|itinerary|schedule|calculate|solve)\b/i;
// The longest message Sonic takes on its own in Auto.
const QUICK_CHARS = 140;

/**
 * The level Auto picks for a request, and why. Building and code think deeper; voice
 * conversations and quick questions get the fastest answer; everything else is everyday work.
 * Summit is never picked automatically: it costs the most, so it's the user's call.
 */
export function autoLevel(
  engine: Engine,
  message: string,
  { files = 0, voice = false }: { files?: number; voice?: boolean } = {},
): { level: ModelLevel; why: string } {
  if (engine === "app" || engine === "slides" || engine === "code") {
    return { level: "vision", why: msg("Building and code get Flash Vision's deeper thinking.") };
  }
  if (DEEP.test(messageWindow(message))) return { level: "vision", why: msg("You asked for careful thinking, so Flash Vision answers.") };
  if (engine !== "text" || files > 0) return { level: "ascend", why: msg("Everyday work runs on Flash Ascend.") };
  if (voice) return { level: "sonic", why: msg("Spoken answers come fastest from Flash Sonic.") };
  const text = message.trim();
  if (text.length <= QUICK_CHARS && !WORK.test(text)) {
    return { level: "sonic", why: msg("A quick question gets Flash Sonic's fast answer.") };
  }
  return { level: "ascend", why: msg("Everyday work runs on Flash Ascend.") };
}

// Sums, units, money and doses, where a quick answer is easily wrong. A number is read from its first
// digit only, so a long run of digits is quick to check.
const CAREFUL =
  /\d\s*([%+\-*/×÷^]|percent|per cent)|(?<!\d)\d+(\.\d+)?\s*(°[cf]|km|mi|kg|lbs?|mg|ml|l\b|usd|eur|gbp|ngn|\$|€|£)|\b(calculate|convert|interest|loan|mortgage|tax|dose|dosage|how much is \d)\b/i;

/** Whether a request has numbers to get right, so Sonic thinks at medium effort for it (see claudeChoice). */
export const needsCare = (message: string) => CAREFUL.test(messageWindow(message));
