import { FriendlyError, MEDIA_WAIT_MS, JobAbandoned } from "./errors.ts";
import { MAX_SPEECH_CHARS } from "../credits.ts";
import { falConfigured, falGenerate, falRun } from "./fal.ts";

export const IMAGE_MODEL = process.env.FLASH_IMAGE_MODEL || "gpt-image-2.5-sunburst";
export const VIDEO_MODEL = process.env.FLASH_VIDEO_MODEL || "sora-2-pro";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  throw new FriendlyError("The image service sent no image back. Please try again.");
}

/**
 * Starts a Sora video job and waits for it, reporting progress through onProgress.
 * Returns the video id; download it with downloadVideo before it expires (about an hour).
 */
export async function generateVideo(prompt: string, onProgress: (pct: number) => void): Promise<string> {
  const res = await fetch(`${OPENAI}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...openaiHeaders() },
    body: JSON.stringify({ model: VIDEO_MODEL, prompt, seconds: "8", size: "1280x720" }),
  });
  if (!res.ok) throw await failure(res, "The video service");
  let job = (await res.json()) as { id: string; status: string; progress?: number; error?: { message?: string } };
  // Leaves time to download the video before the request's time limit.
  const deadline = Date.now() + MEDIA_WAIT_MS - 30_000;
  while (job.status === "queued" || job.status === "in_progress") {
    if (Date.now() > deadline) {
      // A queued job can still be deleted before it runs; a running one will be billed anyway.
      if (job.status === "queued") {
        await fetch(`${OPENAI}/videos/${job.id}`, { method: "DELETE", headers: openaiHeaders() }).catch(() => {});
      }
      throw new JobAbandoned("The video is taking too long, so Flash stopped waiting. Please try again.", job.status !== "queued");
    }
    await sleep(5000);
    const poll = await fetch(`${OPENAI}/videos/${job.id}`, { headers: openaiHeaders() });
    if (!poll.ok) throw await failure(poll, "The video service");
    job = await poll.json();
    onProgress(Math.round(job.progress ?? 0));
  }
  if (job.status !== "completed") throw new Error(job.error?.message ?? `The video failed (${job.status}).`);
  return job.id;
}

/** Downloads a finished Sora video. */
export async function downloadVideo(id: string): Promise<Media> {
  const res = await fetch(`${OPENAI}/videos/${encodeURIComponent(id)}/content`, {
    headers: openaiHeaders(),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw await failure(res, "The video service");
  return { data: Buffer.from(await res.arrayBuffer()), mime: "video/mp4" };
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

/** Transcribes an audio or video file with ElevenLabs Scribe. */
export async function transcribe(file: { name: string; mediaType: string; data: string }): Promise<string> {
  if (!elevenConfigured()) {
    // Files are at most 3 MB, small enough to send inline as a data URI.
    const { result } = await falRun(FAL_TRANSCRIBE, { audio_url: `data:${file.mediaType};base64,${file.data}` });
    const text = (result as { text?: string } | null)?.text?.trim();
    return text || "(No speech found in this file.)";
  }
  const form = new FormData();
  form.append("model_id", TRANSCRIBE_MODEL);
  form.append("file", new Blob([Buffer.from(file.data, "base64")], { type: file.mediaType }), file.name);
  const res = await fetch(`${ELEVEN}/speech-to-text`, { method: "POST", headers: elevenHeaders(), body: form });
  if (!res.ok) throw await failure(res, "The transcription service");
  const json = (await res.json()) as { text?: string; language_code?: string };
  return json.text?.trim() || "(No speech found in this file.)";
}
