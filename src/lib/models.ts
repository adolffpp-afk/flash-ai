import type { Engine } from "./types.ts";

export type Provider = "openai" | "elevenlabs" | "fal";
export type MediaEngine = Extract<Engine, "image" | "video" | "music">;
export const MEDIA_ENGINES: MediaEngine[] = ["image", "video", "music"];

export type ModelInfo = {
  id: string;
  engine: MediaEngine;
  label: string;
  provider: Provider;
  credits: number;
  blurb: string;
  // fal.ai endpoint id, for models served through fal.
  endpoint?: string;
  // Requests that match are sent to this model when Flash picks automatically.
  match?: RegExp;
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
    credits: 5,
    blurb: "Best with words in the picture: logos, posters, menus",
  },
  {
    id: "flux-2-pro",
    engine: "image",
    label: "FLUX.2 Pro",
    provider: "fal",
    credits: 5,
    blurb: "Lifelike photos, portraits and product shots",
    endpoint: "fal-ai/flux-2-pro",
    match: /\b(photo\w*|realistic|lifelike|portrait|headshot|product shot|cinematic|35 ?mm|dslr)\b/i,
  },
  {
    id: "sora-2-pro",
    engine: "video",
    label: "Sora 2 Pro",
    provider: "openai",
    credits: 40,
    blurb: "Polished 8 second clips",
  },
  {
    id: "veo-3.1",
    engine: "video",
    label: "Veo 3.1",
    provider: "fal",
    credits: 50,
    blurb: "Video with sound: speech, music and effects",
    endpoint: "fal-ai/veo3.1",
    match: /\b(sound|audio|dialogue|talking|speaking|says?|saying|voice|narrat\w*|music|singing|noise)\b/i,
  },
  {
    id: "kling-3",
    engine: "video",
    label: "Kling 3 Turbo Pro",
    provider: "fal",
    credits: 45,
    blurb: "Longer 1080p clips, up to 15 seconds",
    endpoint: "fal-ai/kling-video/v3/turbo/pro/text-to-video",
    match: /\b(9|1[0-5])[\s-]*(s|secs?|seconds?)\b|\blong(er)?\s+(video|clip|shot)\b/i,
  },
  {
    id: "eleven-music",
    engine: "music",
    label: "ElevenLabs Music",
    provider: "elevenlabs",
    credits: 15,
    blurb: "Instrumentals, jingles and beats",
  },
  {
    id: "minimax-music",
    engine: "music",
    label: "MiniMax Music 2.6",
    provider: "fal",
    credits: 15,
    blurb: "Full songs with sung lyrics",
    endpoint: "fal-ai/minimax-music/v2.6",
    match: /\b(lyrics|vocals?|sing\w*|sung|singer|rap\w*|choir|song with words)\b/i,
  },
];

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
): { model: ModelInfo; why: string } | null {
  const ready = MODELS.filter((m) => m.engine === engine && available.has(m.provider));
  const chosen = ready.find((m) => m.id === requested);
  if (chosen) return { model: chosen, why: "you picked it" };
  const matched = ready.find((m) => m.match?.test(message));
  if (matched) return { model: matched, why: matched.blurb.toLowerCase() };
  return ready[0] ? { model: ready[0], why: "the default" } : null;
}

/** Seconds asked for in a video request ("a 12 second clip"), clamped to what a model allows. */
export function requestedSeconds(message: string, min: number, max: number, fallback: number): number {
  const n = Number(message.match(/\b(\d{1,2})[\s-]*(?:s|secs?|seconds?)\b/i)?.[1]);
  return n ? Math.min(max, Math.max(min, n)) : fallback;
}
