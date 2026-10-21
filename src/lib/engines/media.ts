import { msg } from "../i18n.ts";
import { FriendlyError, JobAbandoned, MEDIA_WAIT_MS } from "./errors.ts";
import { MAX_SPEECH_CHARS } from "../credits.ts";
import { falConfigured, falGenerate, falRun, falRunNow, falSyncConfigured } from "./fal.ts";

export const IMAGE_MODEL = process.env.FLASH_IMAGE_MODEL || "gpt-image-2.5-sunburst";
// The video model used when none is picked and none fits the request better: a video model in
// models.ts, made on fal.ai (FAL_KEY). FLASH_VIDEO_MODEL can name another of its ids; one that isn't
// a video model there leaves this default.
export const VIDEO_MODEL = process.env.FLASH_VIDEO_MODEL || "veo-3.1";
/** The model an engine falls back to when it is set up (see pickModel): VIDEO_MODEL for videos. */
export const defaultModel = (engine: string): string | undefined => (engine === "video" ? VIDEO_MODEL : undefined);
export const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
export const VOICE_MODEL = process.env.ELEVENLABS_MODEL || "eleven_v4";
export const MUSIC_MODEL = process.env.ELEVENLABS_MUSIC_MODEL || "music_v2_5";
export const TRANSCRIBE_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";

export const openaiConfigured = () => Boolean(process.env.OPENAI_API_KEY);
export const elevenConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY);

// Voice and transcription use ElevenLabs directly when it has a key, otherwise the same ElevenLabs
// models through fal.ai.
const FAL_VOICE = process.env.FAL_VOICE_ENDPOINT || "fal-ai/elevenlabs/tts/turbo-v2.5";
const FAL_TRANSCRIBE = process.env.FAL_TRANSCRIBE_ENDPOINT || "fal-ai/elevenlabs/speech-to-text/scribe-v2";
export const speechProvider = (): "elevenlabs" | "fal" | null =>
  elevenConfigured() ? "elevenlabs" : falConfigured() ? "fal" : null;

const OPENAI = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const ELEVEN = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1";
const openaiHeaders = () => ({ Authorization: `Bearer ${process.env.OPENAI_API_KEY}` });
const elevenHeaders = () => ({ "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" });

async function failure(res: Response, service: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`${service} returned ${res.status}: ${body.slice(0, 300)}`);
}

export type Media = { data: Buffer; mime: string };

/** Generates one image with OpenAI. */
export async function generateImage(prompt: string): Promise<Media> {
  const res = await fetch(`${OPENAI}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...openaiHeaders() },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: process.env.FLASH_IMAGE_SIZE || "1024x1024", n: 1 }),
  });
  if (!res.ok) throw await failure(res, "The image service");
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) return { data: Buffer.from(item.b64_json, "base64"), mime: "image/png" };
  if (item?.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw await failure(img, "The image service");
    return { data: Buffer.from(await img.arrayBuffer()), mime: img.headers.get("content-type") ?? "image/png" };
  }
  throw new FriendlyError(msg("The image service sent no image back. Please try again."));
}

// What OpenAI's picture model costs, in US cents a token: words read ($5 a million), photos read ($8)
// and the picture made ($30).
const READ_WORD_CENTS = 5e-4;
const READ_PHOTO_CENTS = 8e-4;
const MADE_CENTS = 3e-3;

/** OpenAI couldn't take the job (busy, down or out of reach), so it never ran: another editor may do it. */
export class ImageServiceDown extends Error {}

// OpenAI's safety system turned the change down. Nothing was made, so nothing is charged (the chat says
// the credits were refunded), and the photo isn't sent to another editor instead.
export const EDIT_REFUSED = msg("The picture service's safety filter turned down this change. Please ask for it in other words.");

/**
 * Changes a photo with OpenAI's picture model the way the request asks, at medium quality, which keeps
 * it within its price (gpt-image-edit in models.ts). The picture comes back square, wide or tall, like
 * the photo. cents is what OpenAI says it cost, when it says.
 */
export async function editImage(
  photo: { data: string; mediaType: string },
  request: string,
  size: { width: number; height: number } | null,
): Promise<Media & { cents: number | null }> {
  const ratio = size ? size.width / size.height : 1;
  const form = new FormData();
  form.append("model", IMAGE_MODEL);
  // Like ChatGPT, a clearer photo stays the same photo: the same faces, things and colours.
  form.append("prompt", `${request.slice(0, 4000)}\n\n(Change only what is asked. Keep everything else in the photo as it is.)`);
  form.append("image", new Blob([Buffer.from(photo.data, "base64")], { type: photo.mediaType }), `photo.${photo.mediaType.split("/")[1]}`);
  form.append("quality", "medium");
  form.append("size", ratio > 1.2 ? "1536x1024" : ratio < 1 / 1.2 ? "1024x1536" : "1024x1024");
  form.append("n", "1");
  try {
    const res = await fetch(`${OPENAI}/images/edits`, { method: "POST", headers: openaiHeaders(), body: form, signal: AbortSignal.timeout(MEDIA_WAIT_MS) }).catch((err) => {
      if (err instanceof Error && err.name === "TimeoutError") throw err;
      throw new ImageServiceDown(`The image service couldn't be reached: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (res.status === 429 || res.status >= 500) throw new ImageServiceDown((await failure(res, "The image service")).message);
    if (!res.ok) {
      const err = await failure(res, "The image service");
      if (res.status === 400 && /moderation_blocked|safety system/i.test(err.message)) throw new JobAbandoned(EDIT_REFUSED, false);
      throw err;
    }
    const json = (await res.json()) as {
      data?: { b64_json?: string }[];
      usage?: { input_tokens_details?: { text_tokens?: number; image_tokens?: number }; output_tokens?: number };
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new FriendlyError(msg("The image service sent no image back. Please try again."));
    const used = json.usage;
    const cents = used
      ? (used.input_tokens_details?.text_tokens ?? 0) * READ_WORD_CENTS + (used.input_tokens_details?.image_tokens ?? 0) * READ_PHOTO_CENTS + (used.output_tokens ?? 0) * MADE_CENTS
      : null;
    return { data: Buffer.from(b64, "base64"), mime: "image/png", cents };
  } catch (err) {
    // OpenAI bills a picture it started, whether or not anyone waits for it.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new JobAbandoned(msg("This is taking too long, so Flash stopped waiting. Please try again."), true);
    }
    throw err;
  }
}

async function audio(res: Response): Promise<Media> {
  return { data: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
}

/** Speaks the text with ElevenLabs as MP3. */
export async function synthesizeSpeech(text: string, how?: { voice: string; speed: number }): Promise<Media> {
  if (!elevenConfigured()) {
    return falGenerate(FAL_VOICE, { text: text.slice(0, MAX_SPEECH_CHARS), ...(how && { voice: how.voice, speed: how.speed }) });
  }
  const res = await fetch(`${ELEVEN}/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/mpeg", ...elevenHeaders() },
    body: JSON.stringify({ text: text.slice(0, MAX_SPEECH_CHARS), model_id: VOICE_MODEL }),
  });
  if (!res.ok) throw await failure(res, "The voice service");
  return audio(res);
}

/** Composes a 30 second MP3 track with ElevenLabs Music. */
export async function composeMusic(prompt: string, seconds = 30): Promise<Media> {
  const res = await fetch(`${ELEVEN}/music?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...elevenHeaders() },
    body: JSON.stringify({ prompt: prompt.slice(0, 4000), music_length_ms: seconds * 1000, model_id: MUSIC_MODEL }),
  });
  if (!res.ok) throw await failure(res, "The music service");
  return audio(res);
}

/** What a transcript says when a file has no speech in it. Compared as it is, so it's translated where it's shown. */
export const NO_SPEECH = msg("(No speech found in this file.)");

// A spoken turn gives up waiting on fal's queue in time to answer before the browser's own 30-second
// wait ends: a job still in line by then is cancelled, so it costs nothing.
const TURN_WAIT_MS = 22_000;

/**
 * Transcribes an audio or video file with ElevenLabs Scribe. A spoken turn (turn: true) is waited
 * on, so it skips fal's queue, and only words are written down: no "(laughs)" or "(music)". signal
 * stops a turn still in fal's queue once nobody is waiting for it.
 */
export async function transcribe(
  file: { name: string; mediaType: string; data: string },
  { turn = false, signal }: { turn?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  if (!elevenConfigured()) {
    // Files are at most 3 MB, small enough to send inline as a data URI.
    const input = { audio_url: `data:${file.mediaType};base64,${file.data}`, ...(turn && { tag_audio_events: false, diarize: false }) };
    const result =
      turn && falSyncConfigured()
        ? await falRunNow(FAL_TRANSCRIBE, input)
        : // A transcript is a few words, so a turn keeps only a few seconds for fetching it.
          (await falRun(FAL_TRANSCRIBE, input, undefined, turn ? TURN_WAIT_MS : undefined, turn ? { reserveMs: 4000, signal } : {})).result;
    const text = (result as { text?: string } | null)?.text?.trim();
    return text || NO_SPEECH;
  }
  const form = new FormData();
  form.append("model_id", TRANSCRIBE_MODEL);
  if (turn) form.append("tag_audio_events", "false");
  form.append("file", new Blob([Buffer.from(file.data, "base64")], { type: file.mediaType }), file.name);
  // A spoken turn is waited on; a turn that timed out may have run, so it counts as billed.
  const res = await fetch(`${ELEVEN}/speech-to-text`, { method: "POST", headers: elevenHeaders(), body: form, ...(turn && { signal: AbortSignal.timeout(20_000) }) }).catch(
    (err) => {
      if (turn && err instanceof Error && err.name === "TimeoutError") {
        throw new JobAbandoned(msg("This is taking too long, so Flash stopped waiting. Please try again."), true);
      }
      throw err;
    },
  );
  if (!res.ok) throw await failure(res, "The transcription service");
  const json = (await res.json()) as { text?: string; language_code?: string };
  return json.text?.trim() || NO_SPEECH;
}
