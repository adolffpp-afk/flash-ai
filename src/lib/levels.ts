import type { Engine } from "./types.ts";

/*
 * Flash's levels of intelligence: one workspace, four levels, and Auto, which picks the level for
 * each request so people who'd rather not choose get the right mix of quality, speed and cost.
 * Each level runs on a Claude model (see LEVEL_MODELS in engines/claude.ts), and credits follow
 * what the model really costs, so a quick answer on Sonic uses a fraction of an Ultra one.
 * The names still need a trademark lawyer's clearance before Flash is marketed widely.
 */
export const LEVELS = [
  { id: "auto", name: "Auto", short: "Auto", blurb: "Flash picks the level for each request" },
  { id: "sonic", name: "Flash Sonic", short: "Sonic", blurb: "Fastest, and lightest on credits. For quick answers" },
  { id: "ascend", name: "Flash Ascend", short: "Ascend", blurb: "Smart and quick. For everyday writing and research" },
  { id: "vision", name: "Flash Vision", short: "Vision", blurb: "Thinks deeper. For apps, code and hard problems" },
  { id: "ultra", name: "Flash Ultra", short: "Ultra", blurb: "Flash's most capable level, for the hardest work. Uses more credits" },
] as const;

export type Level = (typeof LEVELS)[number]["id"];
export type ModelLevel = Exclude<Level, "auto">;

export const isLevel = (value: unknown): value is Level => LEVELS.some((l) => l.id === value);
export const levelName = (level: Level) => LEVELS.find((l) => l.id === level)!.name;

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
 * Ultra is never picked automatically: it costs the most, so it's the user's call.
 */
export function autoLevel(
  engine: Engine,
  message: string,
  { files = 0, voice = false }: { files?: number; voice?: boolean } = {},
): { level: ModelLevel; why: string } {
  if (engine === "app" || engine === "slides" || engine === "code") {
    return { level: "vision", why: "Building and code get Flash Vision's deeper thinking." };
  }
  if (DEEP.test(message)) return { level: "vision", why: "You asked for careful thinking, so Flash Vision answers." };
  if (engine !== "text" || files > 0) return { level: "ascend", why: "Everyday work runs on Flash Ascend." };
  if (voice) return { level: "sonic", why: "Spoken answers come fastest from Flash Sonic." };
  const text = message.trim();
  if (text.length <= QUICK_CHARS && !WORK.test(text)) {
    return { level: "sonic", why: "A quick question gets Flash Sonic's fast answer." };
  }
  return { level: "ascend", why: "Everyday work runs on Flash Ascend." };
}
