import type { AdShape } from "./ad-studio.ts";

/*
 * Flash Infinity AI Studio, Story mode: drama films in parts, with characters who speak. Claude writes
 * the series (its characters, how they look and sound) and each part's scenes with their dialogue;
 * FLUX.2 paints each character twice (front and side), then each scene's first frame with the cast in
 * it; Kling O3 Pro films each scene from that frame with the characters bound to their pictures, so
 * faces stay the same, and speaks the dialogue with lip-sync; fal's ffmpeg joins the scenes. A next
 * part keeps the same characters and continues the story. Everything runs on fal.ai (FAL_KEY).
 *
 * Prices are fal.ai's, checked 2026-10-23. The price is the most a step can cost; what was really made
 * is charged when it's done.
 */

// FLUX.2 Pro paints a character's front picture: 3 cents.
export const STORY_FACE_CENTS = 3;
// FLUX.2 Edit turns it into a side picture, and paints each scene's first frame with the cast in it:
// at most about 6 megapixels read and one made at $0.008 a megapixel.
export const STORY_EDIT_CENTS = 7;
// Kling O3 Pro reference to video with its own sound (dialogue with lip-sync), $0.14 a second.
export const STORY_CLIP_CENTS_PER_SECOND = 14;
// Fast: MiniMax H3 Max image to video with its own sound (dialogue with lip-sync) in 1080p, $0.16 a
// second (fal, checked 2026-10-23), filmed in seconds rather than minutes, from each scene's first
// frame (painted with the cast in it). Its clips can run up to about 0.7 s long, so a second more a
// scene is held (see storySceneCents).
export const STORY_FAST_CLIP_CENTS_PER_SECOND = 16;
// fal's ffmpeg joins the scenes, sound and all: a cent covers any part.
export const STORY_JOIN_CENTS = 1;
// The story writer (writeStory in engines/claude.ts) and the router, which must stay within it (see
// the helper-costs test).
export const STORY_WRITER_CENTS = 3;
// fal's auto-subtitle (ElevenLabs transcription, word by word captions burned in), $0.03 a minute of film.
export const STORY_SUBTITLE_CENTS_PER_MINUTE = 3;
// A series has at most this many characters with a face (Kling binds at most four to a scene).
export const STORY_MAX_CAST = 4;

/** The part lengths the Studio offers, in seconds. */
export const STORY_LENGTHS = [30, 60, 90, 120] as const;
export const STORY_DEFAULT_SECONDS = 60;

export type StoryPlan = {
  scenes: number;
  // Each scene's length (scenes x seconds is the part's length).
  seconds: number;
  shape: AdShape;
  // Filmed fast with MiniMax H3 Max, rather than with Kling O3 Pro and each face bound to the
  // character's pictures (the best, and the default).
  fast: boolean;
  // Subtitles burned in, word by word like the dramas on TikTok.
  subtitles: boolean;
  // The part this is, and the series it continues (the id of its saved file), from Part 2 on.
  part: number;
  series: string | null;
};

const FORMAT = /^Story format:[^\n]*$/im;
const PART = /^Part: (\d{1,3})$/m;
const SERIES = /^Series: ([A-Za-z0-9_-]{8,64})$/m;
const BOARD = /^Story board: ([A-Za-z0-9_-]{8,64})$/m;

/**
 * How a part is made: its length (30 seconds to 2 minutes, 60 seconds by default) split into scenes of 5 to 15
 * seconds, about 10 each; its shape (vertical, like the dramas on TikTok and Reels, unless asked
 * otherwise); and which part of which series it is.
 */
export function storyPlan(request: string): StoryPlan {
  const chosen = request.match(FORMAT)?.[0] ?? request;
  const minutes = /\b(2|two)[\s-]*min(ute)?s?\b/i.test(chosen) ? 120 : /\b(1|one|a)[\s-]*min(ute)?s?\b/i.test(chosen) ? 60 : 0;
  const said = Number(chosen.match(/\b(\d{2,3})[\s-]*(?:s|secs?|seconds?)\b/i)?.[1]);
  const total = Math.min(120, Math.max(20, minutes || said || STORY_DEFAULT_SECONDS));
  const scenes = Math.max(2, Math.round(total / 10));
  const seconds = Math.min(15, Math.max(5, Math.round(total / scenes)));
  const shape: AdShape = /\b(landscape|16:9|wide|youtube|tv|cinema\w*\s+screen)\b/i.test(chosen)
    ? "wide"
    : /\b(square|1:1)\b/i.test(chosen)
      ? "square"
      : "tall";
  const fast = /\bSpeed: fast\b/i.test(chosen);
  const subtitles = /\bSubtitles: on\b/i.test(chosen);
  return { scenes, seconds, shape, fast, subtitles, part: Math.max(1, Number(request.match(PART)?.[1]) || 1), series: request.match(SERIES)?.[1] ?? null };
}

export const storyLength = (plan: Pick<StoryPlan, "scenes" | "seconds">) => plan.scenes * plan.seconds;

/** The steps of a part: its storyboard (the script, the cast and each scene's first frame), then filming it. */
export type StoryStep = "board" | "film";
export const storyStep = (request: string): StoryStep => (BOARD.test(request) ? "film" : "board");

/** The stored storyboard a film request films (its file id), or null. */
export const storyBoardOf = (request: string): string | null => request.match(BOARD)?.[1] ?? null;

/**
 * The most a storyboard can cost Flash, in cents: the script, a new series' cast and its poster, and a
 * first frame a scene.
 */
export const storyBoardCents = (plan: StoryPlan) =>
  STORY_WRITER_CENTS + (plan.series ? 0 : STORY_MAX_CAST * (STORY_FACE_CENTS + STORY_EDIT_CENTS) + STORY_EDIT_CENTS) + plan.scenes * STORY_EDIT_CENTS;

/** The most filming a part can cost Flash, in cents: every scene with its sound, and the join. */
export const storyFilmCents = (plan: StoryPlan) => plan.scenes * storySceneCents(plan) + STORY_JOIN_CENTS + storySubtitleCents(plan);

/** The most subtitling a part can cost, in cents: nothing without subtitles. */
export const storySubtitleCents = (plan: Pick<StoryPlan, "subtitles" | "scenes" | "seconds">) =>
  plan.subtitles ? STORY_SUBTITLE_CENTS_PER_MINUTE * Math.ceil(storyLength(plan) / 60) : 0;

/** The most filming a scene can cost, in cents, at the plan's speed. */
export const storySceneCents = (plan: Pick<StoryPlan, "fast" | "seconds">) =>
  plan.fast ? STORY_FAST_CLIP_CENTS_PER_SECOND * (plan.seconds + 1) : STORY_CLIP_CENTS_PER_SECOND * plan.seconds;

/** The most a Story mode request can cost Flash, in cents, for the step it asks for: its price. */
export function storyStepCents(request: string): number {
  const plan = storyPlan(request);
  return storyStep(request) === "film" ? storyFilmCents(plan) : storyBoardCents(plan);
}

/**
 * The looks a producer picks for a series, each with the words Flash paints and films it in. "auto"
 * lets the story decide. Ids are kept in requests, so they never change.
 */
export const STORY_LOOKS = {
  auto: "",
  realistic:
    "Photorealistic and true to life, like a real photo or documentary film: real people with natural skin texture, real hair and everyday clothes, natural daylight, real streets, homes and markets as the story sets them, handheld camera, no glamour retouching, no fantasy",
  fantasy:
    "Epic cinematic fantasy, like a blockbuster series: rich saturated colours, glowing magic, ornate armour, gowns and crowns, grand palaces and wild landscapes, dramatic rim light, sweeping camera",
  hollywood:
    "Hollywood blockbuster: anamorphic widescreen film look, rich teal-and-orange colour grade, dramatic contrasty lighting, film grain, epic camera moves, movie-star close-ups, big-budget sets and locations",
  anime: "Japanese anime: cel-shaded drawing, expressive eyes, vibrant colours, detailed painted backgrounds",
  animated: "Stylised 3D animated feature film: soft light, rounded expressive characters, bright colours, like a big-studio family movie",
  cartoon: "2D cartoon: bold outlines, flat bright colours, playful and expressive",
  noir: "Black-and-white film noir: hard shadows, rain-wet streets, smoke, venetian-blind light",
  thriller: "Dark thriller: cold desaturated colours, low-key light, fog and shadows, tense close-ups",
} as const;
export type StoryLook = keyof typeof STORY_LOOKS;
const LOOK = /\bLook: ([a-z]+)\b/;

/** The look a request asks for, or "auto". */
export function storyLook(request: string): StoryLook {
  const id = request.match(FORMAT)?.[0].match(LOOK)?.[1];
  return id && id in STORY_LOOKS ? (id as StoryLook) : "auto";
}

/** The line of choices a part was asked with, which storyPlan reads. */
export function storyChoices(choices: StoryChoices): string {
  const shape = { tall: "vertical 9:16", square: "square 1:1", wide: "landscape 16:9" }[choices.shape];
  const look = choices.look && choices.look !== "auto" ? ` Look: ${choices.look}.` : "";
  return `Story format: ${shape}. Length: ${choices.seconds} seconds.${choices.fast ? " Speed: fast." : ""}${choices.subtitles ? " Subtitles: on." : ""}${look}`;
}

/** What the user picks for a part: its length, its shape, and filming it fast rather than with every face bound. */
export type StoryChoices = { seconds: number; shape: AdShape; fast?: boolean; subtitles?: boolean; look?: StoryLook };

/** The request the Studio sends for a new series' first part: the user's story, then the choices. */
export const storyRequest = (brief: string, choices: StoryChoices) => [brief.trim(), "", storyChoices(choices)].join("\n");

/** The request that writes the next part of a series, with what the user wants to happen in it, if anything. */
export const nextPartRequest = (series: string, part: number, plan: Pick<StoryPlan, "scenes" | "seconds" | "shape" | "fast" | "subtitles">, wish = "") =>
  [
    wish.trim() || `Part ${part}: continue the story.`,
    "",
    storyChoices({ seconds: storyLength(plan), shape: plan.shape, fast: plan.fast, subtitles: plan.subtitles }),
    `Part: ${part}`,
    `Series: ${series}`,
  ].join("\n");

/** The request that films a part's storyboard, with the same choices. */
export const filmPartRequest = (board: string, plan: StoryPlan) =>
  [
    `Film part ${plan.part} in HD.`,
    "",
    storyChoices({ seconds: storyLength(plan), shape: plan.shape, fast: plan.fast, subtitles: plan.subtitles }),
    `Part: ${plan.part}`,
    ...(plan.series ? [`Series: ${plan.series}`] : []),
    `Story board: ${board}`,
  ].join("\n");

export type StoryLine = { who: string; line: string };
export type StoryScene = { picture: string; action: string; lines: StoryLine[] };
export type StoryCharacter = { name: string; look: string; voice: string };

/** What Claude writes for a part: the series (on its first part), and the part's scenes. */
export type StoryScript = {
  title: string;
  // The look of the whole series, kept for every part: the setting, the era, the light, the colours.
  style: string;
  cast: StoryCharacter[];
  // language: the two-letter code of the language its lines are spoken in, for the subtitles.
  part: { title: string; summary: string; language?: string; scenes: StoryScene[] };
};

/** A series as kept between parts: its look, its cast with their two pictures, and its parts so far. */
export type Series = {
  v: 1;
  title: string;
  style: string;
  shape: AdShape;
  cast: (StoryCharacter & { front: string; side: string })[];
  parts: { part: number; title: string; summary: string }[];
};

/** A part's storyboard as kept to film it: its plan, its script, the series it belongs to and its frames. */
export type StoryBoard = {
  v: 1;
  plan: StoryPlan;
  series: Series;
  part: StoryScript["part"];
  // Each scene's first frame, as the id of a file of the user's.
  frames: string[];
};

/** Reads a stored series, or null when it isn't one. */
export function readSeries(text: string): Series | null {
  try {
    const s = JSON.parse(text) as Series;
    if (s?.v !== 1 || !Array.isArray(s.cast) || !Array.isArray(s.parts) || !s.shape) return null;
    if (s.cast.some((c) => !c?.name || !c.front || !c.side)) return null;
    return s;
  } catch {
    return null;
  }
}

/** Reads a stored part's storyboard, or null when it isn't one. */
export function readStoryBoard(text: string): StoryBoard | null {
  try {
    const b = JSON.parse(text) as StoryBoard;
    if (b?.v !== 1 || !b.plan || !b.series || !Array.isArray(b.frames) || !b.part?.scenes?.length) return null;
    if (b.frames.length !== b.plan.scenes || b.part.scenes.length < b.frames.length) return null;
    return b;
  } catch {
    return null;
  }
}

/** Whether a film request's choices are the storyboard's, so its price is what filming it costs. */
export const sameStoryPlan = (a: StoryPlan, b: StoryPlan) =>
  a.scenes === b.scenes &&
  a.seconds === b.seconds &&
  a.shape === b.shape &&
  Boolean(a.fast) === Boolean(b.fast) &&
  Boolean(a.subtitles) === Boolean(b.subtitles);

/** Each shape's frames and pictures, under one megapixel (as the Ads Studio's). */
export const STORY_FRAME: Record<AdShape, { width: number; height: number }> = {
  tall: { width: 720, height: 1280 },
  square: { width: 992, height: 992 },
  wide: { width: 1280, height: 720 },
};

/** The characters in a scene, in the order they're bound to it (at most STORY_MAX_CAST). */
export function sceneCast(scene: StoryScene, cast: { name: string }[]): number[] {
  const text = `${scene.picture} ${scene.action} ${scene.lines.map((l) => l.who).join(" ")}`.toLowerCase();
  return cast.map((c, i) => (text.includes(c.name.toLowerCase()) ? i : -1)).filter((i) => i !== -1).slice(0, STORY_MAX_CAST);
}

/**
 * The prompt Kling films a scene from: the action, then each line spoken by the character bound to
 * it (@Element1, @Element2...), in the voice the series gave them, so their lips move with it. Named,
 * for a model that binds no pictures (Fast), the characters are called by their names.
 */
export function scenePrompt(scene: StoryScene, cast: StoryCharacter[], bound: number[], style: string, named = false): string {
  const tag = (name: string) => {
    const i = cast.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    const at = bound.indexOf(i);
    return at === -1 ? null : named ? cast[i].name : `@Element${at + 1}`;
  };
  let action = scene.action;
  if (!named) for (const [at, i] of bound.entries()) action = action.replace(new RegExp(`\\b${escape(cast[i].name)}\\b`, "gi"), `@Element${at + 1} (${cast[i].name})`);
  const lines = scene.lines.map((l) => {
    const who = tag(l.who);
    const voice = cast.find((c) => c.name.toLowerCase() === l.who.toLowerCase())?.voice;
    return who
      ? `${who} says${voice ? ` in a ${voice} voice` : ""}: "${l.line}"`
      : `A ${voice || "deep narrator"} voice off screen says: "${l.line}"`;
  });
  return [action, ...lines, style ? `Style: ${style}.` : "", "Natural lip-sync, no music, no subtitles, no text on screen."].filter(Boolean).join("\n").slice(0, 2400);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words typed in the chat that ask for a story with characters (a drama, an episode, a trailer...) rather than an ad. */
export const looksLikeStory = (text: string) =>
  /\b(drama|episodes?|series|season|movie|film|short film|trailer|story|characters?|dialogue|scenes?|part \d+)\b/i.test(text) &&
  !/\b(ad|ads|advert\w*|commercial|promo\w*|product|brand|sale|discount|offer)\b/i.test(text);
