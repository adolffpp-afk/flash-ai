import type { Media } from "./media.ts";
import type { Meter, AdScript } from "./claude.ts";
import { BLOCKED, falRun, findFile, flagged } from "./fal.ts";
import { FriendlyError, JobAbandoned, JobStopped } from "./errors.ts";
import { english, msg, type Translate } from "../i18n.ts";
import {
  adClipCents,
  AD_FRAME,
  AD_JOIN_CENTS,
  AD_PICTURE_CENTS,
  AD_PRODUCT_PICTURE_CENTS,
  AD_VOICE_CENTS_PER_CHAR,
  adLength,
  adMusicCents,
  adVoiceChars,
  fitVoiceover,
  type AdPlan,
} from "../ad-studio.ts";
import type { Voice } from "../voices.ts";

// Every part of an ad is made on fal.ai (FAL_KEY); see ad-studio.ts for the prices.
const PICTURE = process.env.FAL_AD_PICTURE_ENDPOINT || "fal-ai/flux-2-pro";
const PRODUCT_PICTURE = process.env.FAL_AD_PRODUCT_ENDPOINT || "fal-ai/flux-2/turbo/edit";
const CLIP = process.env.FAL_AD_CLIP_ENDPOINT || "fal-ai/kling-video/v3/pro/image-to-video";
const FAST_CLIP = process.env.FAL_AD_FAST_CLIP_ENDPOINT || "fal-ai/kling-video/v3/standard/image-to-video";
const VOICE = process.env.FAL_VOICE_ENDPOINT || "fal-ai/elevenlabs/tts/turbo-v2.5";
const MUSIC = process.env.FAL_AD_MUSIC_ENDPOINT || "elevenlabs/music/v2.5";
const JOIN = process.env.FAL_AD_JOIN_ENDPOINT || "fal-ai/ffmpeg-api/compose";

/** How long a whole ad may take, leaving time to save it before the request ends (as a movie). */
export const AD_WAIT_MS = 660_000;
// Kept at the end of the wait for joining the clips and saving the ad.
const JOIN_RESERVE_MS = 120_000;
// The voiceover starts half a second in, so the first word isn't on the cut.
const VOICE_START_MS = 500;

/** What an ad job reports and is stopped by, from the chat route. */
export type AdJob = {
  meter: Meter;
  // Called just before a priced fal job is sent, so a stopped ad pays for what was sent.
  started: (cents: number) => void;
  onProgress: (message: string) => void;
  // A scene as soon as it's filmed (its index and URL on fal), to watch while the rest are.
  onClip?: (index: number, url: string) => void;
  stop?: AbortSignal;
  t?: Translate;
};

/** Runs one fal job and returns the URL of the file it made, metering it once fal bills it (the Story mode uses it too). */
export async function made(endpoint: string, input: Record<string, unknown>, cents: number, job: AdJob, until: number, key = "file"): Promise<string> {
  job.started(cents);
  try {
    const { result } = await falRun(endpoint, input, () => {}, Math.max(30_000, until - Date.now()), { stop: job.stop });
    // fal's safety filter sends a flagged picture back black: it isn't used or charged (as falGenerate).
    if (flagged(result)) {
      job.started(-cents);
      throw new JobAbandoned(BLOCKED, false);
    }
    job.meter("fal", `ad-${key}`, cents);
    const url = key === "join" ? (result as { video_url?: string } | null)?.video_url : findFile(result)?.url;
    if (!url) throw new FriendlyError(msg("The model finished but sent nothing back. Please try again."));
    return url;
  } catch (err) {
    // Taken out of fal's line on Stop, it never ran (see JobStopped).
    if (err instanceof JobStopped) job.started(-cents);
    if (err instanceof JobAbandoned && err.billed) job.meter("fal", `ad-${key}`, cents);
    throw err;
  }
}

/** Downloads a file fal made. */
export async function fetchMade(url: string, fallback: string): Promise<Media> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Couldn't fetch the ad's file: ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || fallback };
}

/**
 * Paints the first frame of every scene at once, in the ad's shape: FLUX.2 Pro from the scene's
 * words, or FLUX.2 Edit putting the user's product photo (a data URI) into the scene. Returns the
 * frames' URLs on fal, in order, and what they cost.
 */
export async function paintFrames(plan: AdPlan, script: AdScript, product: string | null, job: AdJob): Promise<{ urls: string[]; cents: number }> {
  const t = job.t ?? english;
  const until = Date.now() + 240_000;
  const each = product ? AD_PRODUCT_PICTURE_CENTS : AD_PICTURE_CENTS;
  let done = 0;
  const report = () => job.onProgress(t("Painting the scenes… {done} of {count} done", { done, count: script.scenes.length }));
  report();
  const results = await Promise.allSettled(
    script.scenes.map(async (scene) => {
      const url = product
        ? await made(PRODUCT_PICTURE, { prompt: scene.picture, image_urls: [product], image_size: AD_FRAME[plan.shape], output_format: "jpeg" }, each, job, until, "picture")
        : await made(PICTURE, { prompt: scene.picture, image_size: AD_FRAME[plan.shape], output_format: "jpeg" }, each, job, until, "picture");
      done++;
      report();
      return url;
    }),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    // Stopped: the reply ends as stopped, paying for the pictures fal had started.
    const stopped = results.find((r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof JobStopped);
    if (stopped) throw stopped.reason;
    console.error("[flash] ad picture failed", failed.reason);
    if (failed.reason instanceof JobAbandoned && failed.reason.phrase === BLOCKED) {
      throw new FriendlyError(msg("The picture service's safety filter blocked one of the scenes. You only pay for the pictures that were made. Please change the brief and try again."));
    }
    throw new FriendlyError(msg("{failed} of {count} scenes couldn't be painted, so the ad wasn't finished. You only pay for what was made. Please try again."), {
      failed: results.length - done,
      count: results.length,
    });
  }
  return { urls: results.map((r) => (r as PromiseFulfilledResult<string>).value), cents: done * each };
}

/**
 * Films the ad from its first frames (URLs or data URIs, one a scene), with the voiceover and the
 * music made at the same time, then joins it all into one video. The scenes must all be filmed;
 * a voiceover or music that fails is left out, and not charged unless fal billed it.
 * Returns the finished ad and what was made, in cents.
 */
export async function filmAd(
  plan: AdPlan,
  script: AdScript,
  frames: string[],
  voice: { voice: Voice; speed: number },
  job: AdJob,
): Promise<{ video: Media; cents: number; voiceChars: number; music: boolean; notes: string[] }> {
  const t = job.t ?? english;
  const end = Date.now() + AD_WAIT_MS;
  const until = end - JOIN_RESERVE_MS;
  const clipCents = adClipCents(plan) * plan.seconds;
  const words = plan.voice ? fitVoiceover(script.voiceover, adVoiceChars(plan)) : "";
  const voiceCents = words.length * AD_VOICE_CENTS_PER_CHAR;
  const musicCents = plan.music ? adMusicCents(plan) : 0;
  let filmed = 0;
  // Every scene is filmed at once, so the wait is about one scene's, three to eight minutes: the time
  // so far is shown and kept moving, so a long wait never looks stuck.
  const began = Date.now();
  const progress = plan.fast
    ? msg("Filming your ad fast, all scenes at once… {done} of {count} done · {minutes} min so far (usually 2 to 4)")
    : msg("Filming your ad in HD, all scenes at once… {done} of {count} done · {minutes} min so far (usually 3 to 8)");
  const report = () => job.onProgress(t(progress, { done: filmed, count: frames.length, minutes: Math.floor((Date.now() - began) / 60_000) }));
  report();
  const ticking = setInterval(report, 30_000);

  const clips = Promise.allSettled(
    frames.map(async (frame, i) => {
      const url = await made(
        plan.fast ? FAST_CLIP : CLIP,
        { start_image_url: frame, prompt: script.scenes[i]?.motion || "Slow, smooth camera push in.", duration: String(plan.seconds), generate_audio: false },
        clipCents,
        job,
        until,
        "clip",
      );
      filmed++;
      report();
      job.onClip?.(i, url);
      return url;
    }),
  );
  const narration = words
    ? made(VOICE, { text: words, voice: voice.voice.name, speed: voice.speed }, voiceCents, job, until, "voice").catch((err) => {
        console.error("[flash] ad voiceover failed", err);
        return null;
      })
    : Promise.resolve(null);
  const track = plan.music
    ? made(
        MUSIC,
        { prompt: script.music || "Elegant, modern instrumental for an advert, soft enough to sit under a voice.", music_length_ms: adLength(plan) * 1000, force_instrumental: true },
        musicCents,
        job,
        until,
        "music",
      ).catch((err) => {
        console.error("[flash] ad music failed", err);
        return null;
      })
    : Promise.resolve(null);

  const [filmedClips, voiceUrl, musicUrl] = await Promise.all([clips, narration, track]).finally(() => clearInterval(ticking));
  const failed = filmedClips.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    const stopped = filmedClips.find((r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof JobStopped);
    if (stopped) throw stopped.reason;
    console.error("[flash] ad scene failed", failed.reason);
    throw new FriendlyError(msg("{failed} of {count} scenes couldn't be filmed, so the ad wasn't finished. You only pay for what was made. Please try again."), {
      failed: frames.length - filmed,
      count: frames.length,
    });
  }
  const urls = filmedClips.map((r) => (r as PromiseFulfilledResult<string>).value);
  const notes: string[] = [];
  if (words && !voiceUrl) notes.push(t("The voiceover couldn't be made this time, so the ad has none."));
  if (plan.music && !musicUrl) notes.push(t("The music couldn't be made this time, so the ad has none."));

  job.onProgress(t("Joining the scenes, voice and music into one ad…"));
  const sceneMs = plan.seconds * 1000;
  const totalMs = adLength(plan) * 1000;
  const tracks: Record<string, unknown>[] = [
    { id: "scenes", type: "video", keyframes: urls.map((url, i) => ({ url, timestamp: i * sceneMs, duration: sceneMs })) },
  ];
  if (voiceUrl) tracks.push({ id: "voice", type: "audio", keyframes: [{ url: voiceUrl, timestamp: VOICE_START_MS, duration: totalMs - VOICE_START_MS }] });
  if (musicUrl) tracks.push({ id: "music", type: "audio", keyframes: [{ url: musicUrl, timestamp: 0, duration: totalMs }] });
  const joined = await made(JOIN, { tracks }, AD_JOIN_CENTS, job, end - 30_000, "join");
  const video = await fetchMade(joined, "video/mp4").catch((err) => {
    console.error("[flash] ad download failed", err);
    throw new JobAbandoned(msg("Flash couldn't fetch the result. Please try again."), true);
  });
  return {
    video,
    cents: frames.length * clipCents + (voiceUrl ? voiceCents : 0) + (musicUrl ? musicCents : 0) + AD_JOIN_CENTS,
    voiceChars: voiceUrl ? words.length : 0,
    music: Boolean(musicUrl),
    notes,
  };
}
