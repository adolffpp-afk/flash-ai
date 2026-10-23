import { msg } from "./i18n.ts";
import type { Engine } from "./types.ts";
import { CHECK_ALLOWANCE_CENTS, WRITER_ALLOWANCE_CENTS, creditsFor } from "./credits.ts";
import { messageWindow } from "./message-window.ts";
import { adStepCents } from "./ad-studio.ts";

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
  // Takes a photo (used in every scene) or none, so it can be asked for either way.
  anyPhoto?: boolean;
};

const PLATFORM = "(?:instagram|insta|ig|tik ?tok|facebook|fb)";
// At most six in a row: a longer list still holds six, and an unbounded one is slow to check on a long message.
const PLATFORM_LIST = `${PLATFORM}(?:,? (?:and |& |\\+ )?${PLATFORM}){1,5}`;

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

// Words that pick a photo's editing model, which also send a photo with them to the editing models
// (see CLEAR_OR_BIGGER in router.ts).
/** A photo made clearer: "sharper", "unblur it", "it's blurry", "better quality", and the typo "clairer". */
export const CLEARER = String.raw`enhanc\w*|sharpen\w*|sharper|crisper|clearer|clairer|cleare?ier|un-?blur\w*|de-?blur\w*|de-?nois\w*|restor\w*|(more|very|super|really|bit|little|nice and) (clear|sharp|crisp|detailed|defined|focused|in focus)|(less|not|too|so|very|bit|it'?s|is|looks?|looking|kinda|quite) (blurr?y|blurred|pixelated|pixell?y|grainy|noisy|fuzzy|out of focus|unclear|low[- ]?res|low quality)|make (it|this|that|the (photo|picture|image|pic|selfie)) (clear|sharp|crisp)|(better|high|higher|hd|more) quality|(improve|increase|boost|fix|enhance|raise|upgrade) (the |its |this |my )?((photo|picture|image|pic)'?s? )?(quality|clarity|sharpness|focus|definition|details?)|(remove|reduce|fix|get rid of|clean up|take out) (the |any |all |this |that )?(blur\w*|noise|grain\w*|pixelation)`;
/** A photo made bigger: "upscale", "HD", "4K", "higher resolution", "make it bigger". */
export const BIGGER = String.raw`upscal\w*|u?hd|full ?hd|[248] ?k|hi(gh|gher)?[- ]res\w*|highres\w*|(higher|better|more|max\w*|full|bigger|double) resolution|(increase|improve|boost|raise|double|up) (the |its )?(resolution|size)|(it|this|that|photo|picture|image|pic)( a (bit|little|lot)| much)? (bigger|larger)|enlarg\w* (it|this|that|the (photo|picture|image|pic))`;
// Any other change, which the general editor makes: "sharper and brighter" isn't only sharper.
const OTHER_CHANGE = String.raw`remove(?! (the |any |all |this |that )?(blur\w*|noise|grain\w*|pixelation)\b)|replace|swap|add|put|change|style|cartoon\w*|anime|sketch|painting|background|colou?rs?|light\w*|bright\w*|dark\w*|skin|smile`;

/**
 * Image, video and music models Flash can use. For each engine the first model whose
 * provider has a key is the default; a model with `match` wins when the request fits it. For
 * pictures and music, cheaper models come first, so a dearer one is the default only when nothing
 * cheaper is set up. Videos are the exception: their default is VIDEO_MODEL (engines/media.ts) when
 * it is set up, the one with sound, though the one listed after it costs less for 10 seconds. Its
 * price is shown and asked about like any other (price-question.ts).
 */
export const MODELS: ModelInfo[] = [
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
    id: "gpt-image",
    engine: "image",
    label: "GPT Image",
    provider: "openai",
    costCents: 10, // about 3,300 output tokens at $30 per million
    blurb: msg("Best with words in the picture: logos, posters, menus"),
    // After FLUX.2 Pro, a third of its price: the default only when fal.ai isn't set up.
  },
  {
    // Not a single model: Claude writes the scenes, Kling films each one, and fal's ffmpeg joins them.
    id: "movie",
    engine: "video",
    label: "Movie maker",
    provider: "fal",
    // Every scene at Kling's $0.14 a second, plus 2 cents for writing the scenes and joining the clips
    // (MOVIE_EXTRA_CENTS in engines/movie.ts), which pays for the router too.
    costCents: (request) => 14 * movieSeconds(request) + 2,
    blurb: msg("A short film: Flash writes the scenes, films each one and joins them"),
    endpoint: "fal-ai/kling-video/v3/turbo/pro/text-to-video",
    notDefault: true,
    chatOnly: true,
    match: /\b(short film|movie|mini[- ]?movie|trailer|film (with|in) (several|multiple|\d+|[a-z]+) scenes)\b/i,
  },
  {
    // Flash Infinity AI Studio's Ads Studio: not a single model. Claude writes the script, FLUX.2 paints
    // each scene's first frame, Kling 3 Pro films it in 1080p, ElevenLabs reads the voiceover and
    // writes the music, and fal's ffmpeg joins it all (see ad-studio.ts). Asked for from the Studio
    // only, with or without a product photo.
    id: "ad-studio",
    engine: "video",
    label: "Ads Studio",
    provider: "fal",
    // The most the step asked for can cost; what was made is charged (see adMadeCents).
    costCents: (request) => adStepCents(request),
    blurb: msg("A finished ad from one prompt: script, scenes in HD, voiceover and music"),
    endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    notDefault: true,
    chatOnly: true,
    anyPhoto: true,
  },
  {
    id: "remove-bg",
    engine: "image",
    label: "Background remover",
    provider: "fal",
    costCents: 1.8, // Bria RMBG 2.0, $0.018 a photo
    blurb: msg("Cuts out the subject on a transparent background"),
    endpoint: "fal-ai/bria/background/remove",
    edits: true,
    notDefault: true,
    // Taking the background away, but not swapping it for something else (that's an edit).
    match:
      /^(?![\s\S]*\b(replace|swap|change|add|put|with|into|instead|new)\b)[\s\S]*(\b(remove|erase|delete|cut out|get rid of|take out|drop|no)\b[\s\S]{0,30}\bbackground\b|\btransparent\b|\bcut ?out\b|\bbackground[\s-]*(free|less)\b)/i,
  },
  {
    // First for every change to a photo when OpenAI is set up, like ChatGPT: "make it clearer" too, but
    // not "make it bigger" or "4K", which the Upscaler does for a fifth of the price.
    id: "gpt-image-edit",
    engine: "image",
    label: "GPT Image Edit",
    provider: "openai",
    // Medium quality: at most about 2,000 tokens of picture made at $30 per million, the photo read as
    // at most about 6,500 tokens at $8, and the request at $5 (see editImage in engines/media.ts).
    costCents: 12,
    blurb: msg("ChatGPT's picture model: changes your photo the way you ask"),
    edits: true,
    match: new RegExp(`^(?![\\s\\S]*\\b(${OTHER_CHANGE}|${BIGGER})\\b)[\\s\\S]*\\b(${CLEARER})\\b`, "i"),
  },
  {
    id: "upscale",
    engine: "image",
    label: "Upscaler",
    provider: "fal",
    // SeedVR2 at $0.001 per output megapixel; the long side is at most 4,096 pixels (16.8 MP).
    costCents: 1.68,
    blurb: msg("Makes a photo sharper and up to 4 times bigger"),
    endpoint: "fal-ai/seedvr/upscale/image",
    edits: true,
    notDefault: true,
    match: new RegExp(`^(?![\\s\\S]*\\b(${OTHER_CHANGE})\\b)[\\s\\S]*\\b(${BIGGER}|${CLEARER})\\b`, "i"),
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
    // Every video is made on fal.ai: OpenAI's video API ended on 2026-09-24.
    id: "veo-3.1",
    engine: "video",
    label: "Veo 3.1",
    provider: "fal",
    costCents: 320, // 8 seconds with sound at $0.40 a second (fal.ai, checked 2026-10-18)
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
 * How a movie is filmed: its scenes and their length, from "a 1 minute movie" or "a 30 second film"
 * (20 to 90 seconds, default 40). The price and the filming both come from this one split.
 */
export function movieSplit(request: string): { scenes: number; seconds: number } {
  const minutes = Number(request.match(/\b(\d{1,2}(?:\.\d)?|one|two)[\s-]*(?:min|mins|minutes?)\b/i)?.[1]?.replace(/^one$/i, "1").replace(/^two$/i, "2"));
  const asked = minutes ? minutes * 60 : requestedSeconds(request, 20, 90, 40);
  return movieScenes(Math.min(90, Math.max(20, asked)));
}

/** A movie's length in seconds as filmed: its scenes of about 10 seconds each. */
export function movieSeconds(request: string): number {
  const { scenes, seconds } = movieSplit(request);
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

/** Whether a model's request is rewritten by the prompt writer first: new pictures, videos and tracks. */
export const writesPrompt = (model: ModelInfo) => !model.edits && model.id !== "post-pack" && model.id !== "movie" && model.id !== "ad-studio";

/**
 * What Claude helpers may cost for a request on this model, in cents, which its price includes (see
 * CHECK_ALLOWANCE_CENTS): the router or the picture check, and the prompt writer when it writes one.
 * A movie's price already pays for its helpers in the part set aside for writing.
 */
export const helperAllowanceCents = (model: ModelInfo) =>
  model.id === "movie" || model.id === "ad-studio" ? 0 : CHECK_ALLOWANCE_CENTS + (writesPrompt(model) ? WRITER_ALLOWANCE_CENTS : 0);

/**
 * Credits a request on this model costs the user: the price listed in the model picker, the Credits
 * dialog, the pricing page and Flash's tools for other apps, and the price held and charged.
 */
export function modelCredits(model: ModelInfo, request = "", photos = 1): number {
  return creditsFor(requestCents(model, request, photos) + helperAllowanceCents(model));
}

export const modelById = (id: string | undefined) => MODELS.find((m) => m.id === id);

/**
 * Chooses the model for a media request: the one the user asked for if it is set up,
 * else the first set-up model whose strengths match the request, else the engine's
 * default (preferred, when it is set up and may be a default), else its first set-up model.
 * Returns null when no provider for the engine has a key.
 */
export function pickModel(
  engine: MediaEngine,
  message: string,
  available: ReadonlySet<Provider>,
  requested?: string,
  // A photo is attached to edit, so only editing models apply (and none of the others).
  editing = false,
  // The server's default for the engine (VIDEO_MODEL for videos, see engines/media.ts).
  preferred?: string,
): { model: ModelInfo; why: string } | null {
  // A model that takes a photo or none (the Ads Studio) is only ever the one asked for.
  const ready = MODELS.filter((m) => m.engine === engine && available.has(m.provider) && (Boolean(m.edits) === editing || (m.anyPhoto && m.id === requested)));
  const chosen = ready.find((m) => m.id === requested);
  if (chosen) return { model: chosen, why: "you picked it" };
  // A long message is read as its start and end (see message-window.ts).
  const said = messageWindow(message);
  const matched = ready.find((m) => m.match?.test(said));
  if (matched) return { model: matched, why: matched.blurb.toLowerCase() };
  const fallback = ready.find((m) => m.id === preferred && !m.notDefault) ?? ready.find((m) => !m.notDefault);
  return fallback ? { model: fallback, why: "the default" } : null;
}

/** Seconds asked for in a video request ("a 12 second clip"), clamped to what a model allows. */
export function requestedSeconds(message: string, min: number, max: number, fallback: number): number {
  const n = Number(message.match(/\b(\d{1,2})[\s-]*(?:s|secs?|seconds?)\b/i)?.[1]);
  return n ? Math.min(max, Math.max(min, n)) : fallback;
}
