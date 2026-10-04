import type { Engine } from "./types.ts";
import { creditsFor } from "./credits.ts";

export type Provider = "openai" | "elevenlabs" | "fal";
export type MediaEngine = Extract<Engine, "image" | "video" | "music">;
export const MEDIA_ENGINES: MediaEngine[] = ["image", "video", "music"];

export type ModelInfo = {
  id: string;
  engine: MediaEngine;
  label: string;
  provider: Provider;
  // What one request costs Flash, in US cents (provider prices checked 2026-10-02).
  costCents: number | ((request: string) => number);
  blurb: string;
  // fal.ai endpoint id, for models served through fal.
  endpoint?: string;
  // Requests that match are sent to this model when Flash picks automatically.
  match?: RegExp;
  // Only used when picked or matched, never as the engine's default.
  notDefault?: boolean;
  // Edits an attached photo instead of making a new image. Used only when a photo is attached.
  edits?: boolean;
};

/**
 * Image, video and music models Flash can use. For each engine the first model whose
 * provider has a key is the default; a model with `match` wins when the request fits it.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "gpt-image",
    engine: "image",
    label: "GPT Image",
    provider: "openai",
    costCents: 10, // about 3,300 output tokens at $30 per million
    blurb: "Best with words in the picture: logos, posters, menus",
  },
  {
    id: "flux-2-pro",
    engine: "image",
    label: "FLUX.2 Pro",
    provider: "fal",
    costCents: 3, // $0.03 per megapixel
    blurb: "Lifelike photos, portraits and product shots",
    endpoint: "fal-ai/flux-2-pro",
    match: /\b(photo\w*|realistic|lifelike|portrait|headshot|product shot|cinematic|35 ?mm|dslr)\b/i,
  },
  {
    // Not a single model: Claude writes the scenes, Kling films each one, and fal's ffmpeg joins them.
    id: "movie",
    engine: "video",
    label: "Movie maker",
    provider: "fal",
    // Every scene at Kling's $0.14 a second, plus 2 cents for writing the scenes and joining the clips.
    costCents: (request) => 14 * movieSeconds(request) + 2,
    blurb: "A short film: Flash writes the scenes, films each one and joins them",
    endpoint: "fal-ai/kling-video/v3/turbo/pro/text-to-video",
    notDefault: true,
    match: /\b(short film|movie|mini[- ]?movie|trailer|film (with|in) (several|multiple|\d+|[a-z]+) scenes)\b/i,
  },
  {
    id: "flux-2-edit",
    engine: "image",
    label: "FLUX.2 Edit",
    provider: "fal",
    // $0.008 per megapixel in and out; photos are at most 2048 × 2048 (4.2 MP) each way.
    costCents: 7,
    blurb: "Edits your photo: backgrounds, styles, fixes and more",
    endpoint: "fal-ai/flux-2/turbo/edit",
    edits: true,
  },
  {
    id: "sora-2-pro",
    engine: "video",
    label: "Sora 2 Pro",
    provider: "openai",
    costCents: 240, // 8 seconds at $0.30 a second
    blurb: "Polished 8 second clips",
  },
  {
    id: "veo-3.1",
    engine: "video",
    label: "Veo 3.1",
    provider: "fal",
    costCents: 320, // 8 seconds with sound at $0.40 a second
    blurb: "Video with sound: speech, music and effects",
    endpoint: "fal-ai/veo3.1",
    match: /\b(sound|audio|dialogue|talking|speaking|says?|saying|voice|narrat\w*|music|singing|noise)\b/i,
  },
  {
    id: "kling-3",
    engine: "video",
    label: "Kling 3 Turbo Pro",
    provider: "fal",
    costCents: (request) => 14 * videoSeconds(request), // $0.14 a second
    blurb: "Longer 1080p clips, up to 15 seconds",
    endpoint: "fal-ai/kling-video/v3/turbo/pro/text-to-video",
    match: /\b(9|1[0-5])[\s-]*(s|secs?|seconds?)\b|\blong(er)?\s+(video|clip|shot)\b/i,
  },
  {
    id: "eleven-music",
    engine: "music",
    label: "ElevenLabs Music",
    provider: "elevenlabs",
    costCents: 7.5, // 30 seconds at $0.15 a minute
    blurb: "Instrumentals, jingles and beats",
  },
  {
    id: "minimax-music",
    engine: "music",
    label: "MiniMax Music 2.6",
    provider: "fal",
    costCents: 15, // $0.15 a song
    blurb: "Full songs with sung lyrics",
    endpoint: "fal-ai/minimax-music/v2.6",
    match: /\b(lyrics|vocals?|sing\w*|sung|singer|rap\w*|choir|song with words)\b/i,
  },
];

/** Seconds of video a Kling request asks for (3 to 15, default 10). */
export const videoSeconds = (request: string) => requestedSeconds(request, 3, 15, 10);

/**
 * A movie's length in seconds (20 to 90, default 40), from "a 1 minute movie" or "a 30 second film".
 * It is filmed as scenes of about 10 seconds; the cost is the total of the scenes as filmed.
 */
export function movieSeconds(request: string): number {
  const minutes = Number(request.match(/\b(\d{1,2}(?:\.\d)?|one|two)[\s-]*(?:min|mins|minutes?)\b/i)?.[1]?.replace(/^one$/i, "1").replace(/^two$/i, "2"));
  const asked = minutes ? minutes * 60 : requestedSeconds(request, 20, 90, 40);
  const { scenes, seconds } = movieScenes(Math.min(90, Math.max(20, asked)));
  return scenes * seconds;
}

/** How a movie of this length is split: scenes of 5 to 15 seconds, about 10 each. */
export function movieScenes(total: number): { scenes: number; seconds: number } {
  const scenes = Math.max(2, Math.round(total / 10));
  return { scenes, seconds: Math.min(15, Math.max(5, Math.round(total / scenes))) };
}

/** Credits a request on this model costs the user. */
export function modelCredits(model: ModelInfo, request = ""): number {
  return creditsFor(typeof model.costCents === "function" ? model.costCents(request) : model.costCents);
}

export const modelById = (id: string | undefined) => MODELS.find((m) => m.id === id);

/**
 * Chooses the model for a media request: the one the user asked for if it is set up,
 * else the first set-up model whose strengths match the request, else the engine's
 * first set-up model. Returns null when no provider for the engine has a key.
 */
export function pickModel(
  engine: MediaEngine,
  message: string,
  available: ReadonlySet<Provider>,
  requested?: string,
  // A photo is attached to edit, so only editing models apply (and none of the others).
  editing = false,
): { model: ModelInfo; why: string } | null {
  const ready = MODELS.filter((m) => m.engine === engine && available.has(m.provider) && Boolean(m.edits) === editing);
  const chosen = ready.find((m) => m.id === requested);
  if (chosen) return { model: chosen, why: "you picked it" };
  const matched = ready.find((m) => m.match?.test(message));
  if (matched) return { model: matched, why: matched.blurb.toLowerCase() };
  const fallback = ready.find((m) => !m.notDefault);
  return fallback ? { model: fallback, why: "the default" } : null;
}

/** Seconds asked for in a video request ("a 12 second clip"), clamped to what a model allows. */
export function requestedSeconds(message: string, min: number, max: number, fallback: number): number {
  const n = Number(message.match(/\b(\d{1,2})[\s-]*(?:s|secs?|seconds?)\b/i)?.[1]);
  return n ? Math.min(max, Math.max(min, n)) : fallback;
}
