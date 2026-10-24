import { shapeOf, type Shape } from "./engines/fal-input.ts";

/*
 * Flash Infinity AI Studio, phase 1: the Ads Studio. One request makes a finished ad: Claude writes
 * the script, FLUX.2 paints the first frame of every scene in the shape asked for (or puts the user's
 * product photo into it), Kling films each frame, ElevenLabs reads the voiceover and writes the music,
 * and fal's ffmpeg joins it all (engines/ad-studio.ts). Everything runs on fal.ai, so it needs no
 * key besides FAL_KEY and Claude's.
 *
 * Prices are fal.ai's, checked 2026-10-23. The price is the most an ad can cost; what was really made
 * is charged when it's done (adMadeCents).
 */

// FLUX.2 Pro paints each scene's first frame, under one megapixel: 3 cents.
export const AD_PICTURE_CENTS = 3;
// FLUX.2 Edit puts the user's product photo into a scene: at most 4.2 megapixels read and one made
// at $0.008 a megapixel (the flux-2-edit price in models.ts).
export const AD_PRODUCT_PICTURE_CENTS = 7;
// Kling 3 Pro image to video, silent, $0.112 a second.
export const AD_CLIP_CENTS_PER_SECOND = 11.2;
// Fast: Kling 3 Standard, the same silent in 720p, about twice as quick, $0.084 a second.
export const AD_FAST_CLIP_CENTS_PER_SECOND = 8.4;
// ElevenLabs Music v2.5 on fal, $0.60 for every minute started.
export const AD_MUSIC_CENTS_PER_MINUTE = 60;
// ElevenLabs Turbo v2.5 on fal, $0.05 for 1,000 characters (voiceCostCents in credits.ts).
export const AD_VOICE_CENTS_PER_CHAR = 0.005;
// fal's ffmpeg compose, $0.0002 a second of video: a cent covers any ad.
export const AD_JOIN_CENTS = 1;
// The script writer (writeAd in engines/claude.ts) and the router, which must stay within it (see the
// helper-costs test).
export const AD_WRITER_CENTS = 1;
// The voiceover is read at about 15 characters a second, so a script never runs over the ad.
export const AD_VOICE_CHARS_PER_SECOND = 15;

/** The lengths the Studio offers, in seconds. */
export const AD_LENGTHS = [15, 30, 60] as const;
export const AD_DEFAULT_SECONDS = 30;

export type AdShape = "tall" | "square" | "wide";
export type AdPlan = {
  // How the ad is filmed: its scenes and their length (scenes x seconds is the ad's length).
  scenes: number;
  seconds: number;
  shape: AdShape;
  voice: boolean;
  music: boolean;
  // Filmed fast in 720p rather than at its best in 1080p; only there when asked for.
  fast?: boolean;
};

/** The aspect ratio of each shape, as video models and the Studio say it. */
export const AD_RATIO: Record<AdShape, "9:16" | "1:1" | "16:9"> = { tall: "9:16", square: "1:1", wide: "16:9" };

/** Each shape's first frames, under one megapixel so each costs AD_PICTURE_CENTS. */
export const AD_FRAME: Record<AdShape, { width: number; height: number }> = {
  tall: { width: 720, height: 1280 },
  square: { width: 992, height: 992 },
  wide: { width: 1280, height: 720 },
};

const toAdShape = (shape: Shape | null): AdShape => (shape === "tall" || shape === "portrait" ? "tall" : shape === "square" ? "square" : "wide");

/**
 * How an ad request is made: its length ("30 seconds", "1 minute", 10 to 60 seconds, 30 by
 * default), split into scenes of 5 to 10 seconds; its shape (a TikTok or Reels ad is tall, wide
 * otherwise); and whether it has a voiceover and music (both, unless asked without).
 */
export function adPlan(request: string): AdPlan {
  // The Studio's own line of choices wins over words in the brief (see adRequest).
  const chosen = request.match(/^Format:[^\n]*$/im)?.[0];
  if (chosen) request = chosen;
  const minutes = /\b(one|1|a)[\s-]*min(ute)?s?\b/i.test(request) ? 60 : 0;
  const said = Number(request.match(/\b(\d{1,2})[\s-]*(?:s|secs?|seconds?)\b/i)?.[1]);
  const total = Math.min(60, Math.max(10, minutes || said || AD_DEFAULT_SECONDS));
  const scenes = Math.max(2, Math.ceil(total / 10));
  const seconds = Math.min(10, Math.max(5, Math.round(total / scenes)));
  return {
    scenes,
    seconds,
    shape: toAdShape(shapeOf(request)),
    voice: !/\b(no|without)\s+(a\s+)?(voice[\s-]?over|voice|narrat\w*|narrator|speaking)\b|\bvoice[\s-]?over:\s*no\b/i.test(request),
    music: !/\b(no|without)\s+(any\s+)?(music|soundtrack)\b|\bmusic:\s*no\b/i.test(request),
    ...(/\bSpeed: fast\b/i.test(request) ? { fast: true } : {}),
  };
}

/** The ad's length in seconds, as filmed. */
export const adLength = (plan: AdPlan) => plan.scenes * plan.seconds;

/** The most characters of voiceover an ad of this plan reads. */
export const adVoiceChars = (plan: AdPlan) => adLength(plan) * AD_VOICE_CHARS_PER_SECOND;

/** What a second of a scene costs, in cents, at the plan's speed. */
export const adClipCents = (plan: Pick<AdPlan, "fast">) => (plan.fast ? AD_FAST_CLIP_CENTS_PER_SECOND : AD_CLIP_CENTS_PER_SECOND);

export const adMusicCents = (plan: AdPlan) => AD_MUSIC_CENTS_PER_MINUTE * Math.ceil(adLength(plan) / 60);

/**
 * What an ad can cost Flash at most, in cents: the price held and shown. A product photo costs a
 * little more for each scene's first frame, so the price always counts it.
 */
export function adCostCents(plan: AdPlan): number {
  return (
    AD_WRITER_CENTS +
    plan.scenes * (AD_PRODUCT_PICTURE_CENTS + plan.seconds * adClipCents(plan)) +
    (plan.voice ? adVoiceChars(plan) * AD_VOICE_CENTS_PER_CHAR : 0) +
    (plan.music ? adMusicCents(plan) : 0) +
    AD_JOIN_CENTS
  );
}

/**
 * What an ad cost as made, in cents, which is what is charged: its scenes as filmed, its first
 * frames painted or made from the product photo, the voiceover as read, and the music if made.
 */
export function adMadeCents(made: { plan: AdPlan; scenes: number; product: boolean; voiceChars: number; music: boolean }): number {
  const { plan } = made;
  return (
    AD_WRITER_CENTS +
    made.scenes * ((made.product ? AD_PRODUCT_PICTURE_CENTS : AD_PICTURE_CENTS) + plan.seconds * adClipCents(plan)) +
    made.voiceChars * AD_VOICE_CENTS_PER_CHAR +
    (made.music ? adMusicCents(plan) : 0) +
    AD_JOIN_CENTS
  );
}

/**
 * The steps of an ad. A storyboard writes the script and paints each scene's first frame, cheaply,
 * so the user sees it before paying to film it; film films a storyboard made before; whole does both
 * in one go.
 */
export type AdStep = "storyboard" | "film" | "whole";

const STORYBOARD_ONLY = /^Storyboard only\.?$/im;
const FILM_FROM = /^Storyboard: ([A-Za-z0-9_-]{8,64})$/m;

export function adStep(request: string): AdStep {
  if (FILM_FROM.test(request)) return "film";
  return STORYBOARD_ONLY.test(request) ? "storyboard" : "whole";
}

/** The stored storyboard a film request films (its file id), or null. */
export const storyboardOf = (request: string): string | null => request.match(FILM_FROM)?.[1] ?? null;

/** The most a storyboard can cost Flash, in cents: the script and a first frame a scene. */
export const storyboardCents = (plan: AdPlan) => AD_WRITER_CENTS + plan.scenes * AD_PRODUCT_PICTURE_CENTS;

/** The most filming a storyboard can cost Flash, in cents: the clips, the voiceover, the music and the join. */
export const filmCents = (plan: AdPlan) =>
  plan.scenes * plan.seconds * adClipCents(plan) +
  (plan.voice ? adVoiceChars(plan) * AD_VOICE_CENTS_PER_CHAR : 0) +
  (plan.music ? adMusicCents(plan) : 0) +
  AD_JOIN_CENTS;

/** The most an ad request can cost Flash, in cents, for the step it asks for: its price. */
export function adStepCents(request: string): number {
  const plan = adPlan(request);
  const step = adStep(request);
  return step === "storyboard" ? storyboardCents(plan) : step === "film" ? filmCents(plan) : adCostCents(plan);
}

/** The line of choices an ad was asked with, which adPlan reads. */
export function choicesLine(plan: Pick<AdPlan, "shape" | "voice" | "music" | "fast"> & { seconds: number }): string {
  const shape = { tall: "vertical 9:16", square: "square 1:1", wide: "landscape 16:9" }[plan.shape];
  return `Format: ${shape}. Length: ${plan.seconds} seconds. Voiceover: ${plan.voice ? "yes" : "no"}. Music: ${plan.music ? "yes" : "no"}.${plan.fast ? " Speed: fast." : ""}`;
}

/** The request the Studio sends: the user's brief, then the choices it was made with. */
export function adRequest(brief: string, choices: { seconds: number; shape: AdShape; voice: boolean; music: boolean; fast?: boolean; storyboard?: boolean }): string {
  return [brief.trim(), "", choicesLine(choices), ...(choices.storyboard ? ["Storyboard only."] : [])].join("\n");
}

/** The request that films a storyboard: the same choices, and the storyboard to film. */
export const filmRequest = (id: string, plan: AdPlan) =>
  ["Film this storyboard in HD.", "", choicesLine({ ...plan, seconds: adLength(plan) }), `Storyboard: ${id}`].join("\n");

/** What a storyboard keeps, for filming it later: saved as a JSON file of the user's. */
export type Storyboard = {
  v: 1;
  plan: AdPlan;
  script: { title: string; scenes: { picture: string; motion: string }[]; voiceover: string; voice: string; music: string };
  // Each scene's first frame, as the id of a file of the user's.
  frames: string[];
};

/** Reads a stored storyboard, or null when it isn't one. */
export function readStoryboard(text: string): Storyboard | null {
  try {
    const s = JSON.parse(text) as Storyboard;
    if (s?.v !== 1 || !Array.isArray(s.frames) || !s.frames.length || !s.script?.scenes?.length || !s.plan) return null;
    if (s.frames.length !== s.plan.scenes || s.script.scenes.length < s.frames.length) return null;
    return s;
  } catch {
    return null;
  }
}

/** Whether a film request's choices are the storyboard's, so its price is what filming it costs. */
export const samePlan = (a: AdPlan, b: AdPlan) =>
  a.scenes === b.scenes &&
  a.seconds === b.seconds &&
  a.shape === b.shape &&
  a.voice === b.voice &&
  a.music === b.music &&
  Boolean(a.fast) === Boolean(b.fast);

/** Cuts a voiceover to at most max characters, at the end of a sentence or word. */
export function fitVoiceover(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("。"));
  if (sentence > max / 2) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

// Words that say the request is something to film, on their own or with a cue of filming, and
// words that say it's something to build.
const FILM_SURE = /\b(trailers?|short films?|commercials?|adverts?|advertisements?|video ads?|cinematic|voice[\s-]?overs?|narrators?)\b/i;
const FILM_MAYBE = /\b(movies?|films?|videos?|reels?|ads?|clips?)\b/i;
const FILM_CUES = /\b(scenes?|shots?|camera|narrat\w*|soundtrack|music)\b|\b\d+[\s-]*(s|secs?|seconds?|mins?|minutes?)\b|\b(make|create|generate|produce|film|shoot|write)\s+(me\s+)?(an?|the|my)?\s*\w*\s*(movies?|films?|videos?|reels?|ads?)\b/i;
const BUILD_WORDS =
  /\b(apps?|application|websites?|web ?site|web ?pages?|landing pages?|dashboards?|platforms?|portals?|trackers?|database|api|plugins?|extensions?|chatbots?|slides|slide deck|presentations?|spreadsheets?)\b/i;

/**
 * Whether a message typed in the chat asks for a video, an ad or a movie to be made, so Flash can
 * offer the Studio instead of, say, building an app with it. Something to build (a movie review app)
 * never is.
 */
export function looksLikeFilm(text: string): boolean {
  const words = text.slice(0, 3000);
  if (BUILD_WORDS.test(words)) return false;
  return FILM_SURE.test(words) || (FILM_MAYBE.test(words) && FILM_CUES.test(words));
}

/** The Studio's length nearest to the one a brief asks for. */
export const adSecondsOf = (brief: string) => {
  const asked = adLength(adPlan(brief));
  return AD_LENGTHS.reduce((best, s) => (Math.abs(s - asked) < Math.abs(best - asked) ? s : best), AD_DEFAULT_SECONDS as number);
};
