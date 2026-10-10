import { msg } from "./i18n.ts";
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
  // Runs several steps in a chat (writing, then filming or painting), so apps and the connector never get it.
  chatOnly?: boolean;
};

const PLATFORM = "(?:instagram|insta|ig|tik ?tok|facebook|fb)";
const PLATFORM_LIST = `${PLATFORM}(?:,? (?:and |& |\\+ )?${PLATFORM})+`;

/**
 * Asking for a social post pack: "a social media pack", or posts for two or more of Instagram, TikTok
 * and Facebook. Not "content pack" or "marketing kit", which often mean something else.
 */
export const POST_PACK_REQUEST = new RegExp(
  `\\b(?:(?:social[- ]?media|social|posts?)[- ]?(?:posts? )?(?:pack|kit|bundle)s?\\b|posts? for ${PLATFORM_LIST}\\b|${PLATFORM_LIST} posts?\\b)`,
  "i",
);

/** Whether a post pack request asks for the short video too ("with a video", "for Reels"). */
export const packWantsVideo = (request: string) =>
  /\b(videos?|reels?|clips?|animation)\b/i.test(request) &&
  !/\b(no|without|skip|minus|not)\s+(a\s+|the\s+|any\s+)?(videos?|reels?|clips?|animation)\b|\b(pictures?|photos?|images?) only\b/i.test(request);

// What a social post pack costs Flash, in cents: writing the posts (held to this by the writer),
// two FLUX.2 Pro pictures, and a silent 5 second Kling 3 Pro video made from the tall picture.
export const PACK_WRITING_CENTS = 5;
export const PACK_IMAGE_CENTS = 3;
export const PACK_VIDEO_SECONDS = 5;
export const PACK_VIDEO_CENTS = 56; // 5 seconds at 11.2 cents a second
export const PACK_VIDEO_ENDPOINT = "fal-ai/kling-video/v3/pro/image-to-video";

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
    blurb: msg("Best with words in the picture: logos, posters, menus"),
  },
  {
    // Not a single model: Claude writes the posts, FLUX.2 Pro paints a square and a tall picture,
    // and Kling animates the tall one when a video is asked for. Listed first so "photo" in a
    // pack request doesn't send it to a single picture.
    id: "post-pack",
    engine: "image",
    label: "Social post pack",
    provider: "fal",
    costCents: (request) => PACK_WRITING_CENTS + 2 * PACK_IMAGE_CENTS + (packWantsVideo(request) ? PACK_VIDEO_CENTS : 0),
    blurb: msg("Posts, hashtags and pictures for Instagram, TikTok and Facebook, with a video if you ask"),
    endpoint: "fal-ai/flux-2-pro",
    notDefault: true,
    chatOnly: true,
    match: POST_PACK_REQUEST,
  },
  {
    id: "flux-2-pro",
    engine: "image",
    label: "FLUX.2 Pro",
    provider: "fal",
    costCents: 3, // $0.03 per megapixel
    blurb: msg("Lifelike photos, portraits and product shots"),
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
    blurb: msg("A short film: Flash writes the scenes, films each one and joins them"),
    endpoint: "fal-ai/kling-video/v3/turbo/pro/text-to-video",
    notDefault: true,
    chatOnly: true,
    match: /\b(short film|movie|mini[- ]?movie|trailer|film (with|in) (several|multiple|\d+|[a-z]+) scenes)\b/i,
  },
  {
    id: "remove-bg",
    engine: "image",
    label: "Background remover",
    provider: "fal",
    costCents: 2, // Bria RMBG 2.0, $0.018 a photo
    blurb: msg("Cuts out the subject on a transparent background"),
    endpoint: "fal-ai/bria/background/remove",
    edits: true,
    notDefault: true,
    // Taking the background away, but not swapping it for something else (that's an edit).
    match:
      /^(?![\s\S]*\b(replace|swap|change|add|put|with|into|instead|new)\b)[\s\S]*(\b(remove|erase|delete|cut out|get rid of|take out|drop|no)\b[\s\S]{0,30}\bbackground\b|\btransparent\b|\bcut ?out\b|\bbackground[\s-]*(free|less)\b)/i,
  },
  {
    id: "upscale",
    engine: "image",
    label: "Upscaler",
    provider: "fal",
    // SeedVR2 at $0.001 per output megapixel; the long side is at most 4,096 pixels (16.8 MP).
    costCents: 2,
    blurb: msg("Makes a photo sharper and up to 4 times bigger"),
    endpoint: "fal-ai/seedvr/upscale/image",
    edits: true,
    notDefault: true,
    match:
      /^(?![\s\S]*\b(remove|replace|swap|add|put|change|style|cartoon\w*|anime|sketch|painting|background|colou?rs?|light\w*|skin|smile)\b)[\s\S]*\b(upscale\w*|enhance|sharpen\w*|sharper|crisper|clearer|unblur|de-?blur|hd|4k|high[- ]?res\w*|higher[- ]res\w*|(higher|better|more) (resolution|quality)|bigger|larger|enlarge|increase (the )?(resolution|size|quality)|improve (the )?quality)\b/i,
  },
  {
    id: "flux-2-edit",
    engine: "image",
    label: "FLUX.2 Edit",
    provider: "fal",
    // $0.008 per megapixel in and out; photos are at most 2048 × 2048 (4.2 MP) each way.
    costCents: 7,
    blurb: msg("Edits your photo: backgrounds, styles, fixes and more"),
    endpoint: "fal-ai/flux-2/turbo/edit",
    edits: true,
  },
  {
    // Brings an attached photo to life. Sound only when the request asks for it, since it costs half as much again.
    id: "kling-3-animate",
    engine: "video",
    label: "Kling 3 Pro (animate photo)",
    provider: "fal",
    costCents: (request) => animateSeconds(request) * (wantsSound(request) ? 16.8 : 11.2),
    blurb: msg("Turns your photo into a short video, with sound if you ask"),
    endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    edits: true,
  },
  {
    id: "sora-2-pro",
    engine: "video",
    label: "Sora 2 Pro",
    provider: "openai",
    costCents: 240, // 8 seconds at $0.30 a second
    blurb: msg("Polished 8 second clips"),
  },
  {
    id: "veo-3.1",
    engine: "video",
    label: "Veo 3.1",
    provider: "fal",
    costCents: 320, // 8 seconds with sound at $0.40 a second
    blurb: msg("Video with sound: speech, music and effects"),
    endpoint: "fal-ai/veo3.1",
    match: /\b(sound|audio|dialogue|talking|speaking|says?|saying|voice|narrat\w*|music|singing|noise)\b/i,
  },
  {
    id: "kling-3",
    engine: "video",
    label: "Kling 3 Turbo Pro",
    provider: "fal",
    costCents: (request) => 14 * videoSeconds(request), // $0.14 a second
    blurb: msg("Longer 1080p clips, up to 15 seconds"),
    endpoint: "fal-ai/kling-video/v3/turbo/pro/text-to-video",
    match: /\b(9|1[0-5])[\s-]*(s|secs?|seconds?)\b|\blong(er)?\s+(video|clip|shot)\b/i,
  },
  {
    id: "eleven-music",
    engine: "music",
    label: "ElevenLabs Music",
    provider: "elevenlabs",
    costCents: 7.5, // 30 seconds at $0.15 a minute
    blurb: msg("Instrumentals, jingles and beats"),
  },
  {
    id: "minimax-music",
    engine: "music",
    label: "MiniMax Music 2.6",
    provider: "fal",
    costCents: 15, // $0.15 a song
    blurb: msg("Full songs with sung lyrics"),
    endpoint: "fal-ai/minimax-music/v2.6",
    match: /\b(lyrics|vocals?|sing\w*|sung|singer|rap\w*|choir|song with words)\b/i,
  },
];

/** Seconds an animated photo lasts (3 to 15, default 5). */
export const animateSeconds = (request: string) => requestedSeconds(request, 3, 15, 5);

/** Whether a video request asks for sound. */
export const wantsSound = (request: string) =>
  /\b(sound|audio|dialogue|talking|speaking|says?|saying|voice|narrat\w*|music|singing|noise|ambien\w*)\b/i.test(request) &&
  !/\b(no|without|silent|mute\w*)\s+(sound|audio|music)\b|\bsilent\b/i.test(request);

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

// FLUX.2 Edit can combine several photos ("put me and my dog on a beach") and reads at most 4.
export const MAX_EDIT_PHOTOS = 4;
// Each photo after the first adds up to 4.2 megapixels read, at $0.008 a megapixel.
const EXTRA_PHOTO_CENTS = 3.5;

/** What a request on this model costs Flash, in cents; a photo edit costs more for each extra photo. */
export function requestCents(model: ModelInfo, request = "", photos = 1): number {
  const cents = typeof model.costCents === "function" ? model.costCents(request) : model.costCents;
  const extra = Math.min(Math.max(photos, 1), MAX_EDIT_PHOTOS) - 1;
  return model.id === "flux-2-edit" ? cents + extra * EXTRA_PHOTO_CENTS : cents;
}

/** Credits a request on this model costs the user. */
export function modelCredits(model: ModelInfo, request = "", photos = 1): number {
  return creditsFor(requestCents(model, request, photos));
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
