export const IMAGE_MODEL = process.env.FLASH_IMAGE_MODEL || "gpt-image-2.5-sunburst";
export const VIDEO_MODEL = process.env.FLASH_VIDEO_MODEL || "sora-2-pro";
export const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
export const VOICE_MODEL = process.env.ELEVENLABS_MODEL || "eleven_v4";
export const MUSIC_MODEL = process.env.ELEVENLABS_MUSIC_MODEL || "music_v2_5";
export const TRANSCRIBE_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";

export const openaiConfigured = () => Boolean(process.env.OPENAI_API_KEY);
export const elevenConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY);

const OPENAI = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const ELEVEN = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1";
const openaiHeaders = () => ({ Authorization: `Bearer ${process.env.OPENAI_API_KEY}` });
const elevenHeaders = () => ({ "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" });

async function failure(res: Response, service: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`${service} returned ${res.status}: ${body.slice(0, 300)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Generates one image with OpenAI and returns it as a data URL. */
export async function generateImage(prompt: string): Promise<string> {
  const res = await fetch(`${OPENAI}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...openaiHeaders() },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: process.env.FLASH_IMAGE_SIZE || "1024x1024", n: 1 }),
  });
  if (!res.ok) throw await failure(res, "The image service");
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return item.url;
  throw new Error("The image service returned no image.");
}

/**
 * Starts a Sora video job and waits for it, reporting progress through onProgress.
 * Returns the video id; the finished file is served by /api/video/[id].
 */
export async function generateVideo(prompt: string, onProgress: (pct: number) => void): Promise<string> {
  const res = await fetch(`${OPENAI}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...openaiHeaders() },
    body: JSON.stringify({ model: VIDEO_MODEL, prompt, seconds: "8", size: "1280x720" }),
  });
  if (!res.ok) throw await failure(res, "The video service");
  let job = (await res.json()) as { id: string; status: string; progress?: number; error?: { message?: string } };
  const deadline = Date.now() + 9 * 60 * 1000;
  while (job.status === "queued" || job.status === "in_progress") {
    if (Date.now() > deadline) throw new Error("The video is taking too long. Please try again.");
    await sleep(5000);
    const poll = await fetch(`${OPENAI}/videos/${job.id}`, { headers: openaiHeaders() });
    if (!poll.ok) throw await failure(poll, "The video service");
    job = await poll.json();
    onProgress(Math.round(job.progress ?? 0));
  }
  if (job.status !== "completed") throw new Error(job.error?.message ?? `The video failed (${job.status}).`);
  return job.id;
}

/** Fetches a finished Sora video as a response body (used by the /api/video proxy). */
export async function fetchVideo(id: string): Promise<Response> {
  return fetch(`${OPENAI}/videos/${encodeURIComponent(id)}/content`, { headers: openaiHeaders() });
}

async function audioToDataUrl(res: Response): Promise<string> {
  const audio = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${audio}`;
}

/** Speaks the text with ElevenLabs and returns an MP3 data URL. */
export async function synthesizeSpeech(text: string): Promise<string> {
  const res = await fetch(`${ELEVEN}/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/mpeg", ...elevenHeaders() },
    body: JSON.stringify({ text: text.slice(0, 10000), model_id: VOICE_MODEL }),
  });
  if (!res.ok) throw await failure(res, "The voice service");
  return audioToDataUrl(res);
}

/** Composes a 30 second track with ElevenLabs Music and returns an MP3 data URL. */
export async function composeMusic(prompt: string, seconds = 30): Promise<string> {
  const res = await fetch(`${ELEVEN}/music?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...elevenHeaders() },
    body: JSON.stringify({ prompt: prompt.slice(0, 4000), music_length_ms: seconds * 1000, model_id: MUSIC_MODEL }),
  });
  if (!res.ok) throw await failure(res, "The music service");
  return audioToDataUrl(res);
}

/** Transcribes an audio or video file with ElevenLabs Scribe. */
export async function transcribe(file: { name: string; mediaType: string; data: string }): Promise<string> {
  const form = new FormData();
  form.append("model_id", TRANSCRIBE_MODEL);
  form.append("file", new Blob([Buffer.from(file.data, "base64")], { type: file.mediaType }), file.name);
  const res = await fetch(`${ELEVEN}/speech-to-text`, { method: "POST", headers: elevenHeaders(), body: form });
  if (!res.ok) throw await failure(res, "The transcription service");
  const json = (await res.json()) as { text?: string; language_code?: string };
  return json.text?.trim() || "(No speech found in this file.)";
}
