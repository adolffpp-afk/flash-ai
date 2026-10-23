import type { Media } from "./media.ts";
import { BLOCKED } from "./fal.ts";
import { FriendlyError, JobAbandoned, JobStopped } from "./errors.ts";
import { english, msg } from "../i18n.ts";
import { fetchMade, made, AD_WAIT_MS, type AdJob } from "./ad-studio.ts";
import {
  STORY_CLIP_CENTS_PER_SECOND,
  STORY_EDIT_CENTS,
  STORY_FACE_CENTS,
  STORY_FRAME,
  STORY_JOIN_CENTS,
  sceneCast,
  scenePrompt,
  type StoryCharacter,
  type StoryPlan,
  type StoryScene,
} from "../story-studio.ts";

// Every part of a story is made on fal.ai (FAL_KEY); see story-studio.ts for the prices.
const FACE = process.env.FAL_STORY_FACE_ENDPOINT || "fal-ai/flux-2-pro";
const EDIT = process.env.FAL_STORY_EDIT_ENDPOINT || "fal-ai/flux-2/turbo/edit";
const CLIP = process.env.FAL_STORY_CLIP_ENDPOINT || "fal-ai/kling-video/o3/pro/reference-to-video";
const MERGE = process.env.FAL_MERGE_ENDPOINT || "fal-ai/ffmpeg-api/merge-videos";

// Kept at the end of the wait for joining the scenes and saving the part.
const JOIN_RESERVE_MS = 120_000;

/** A character's two pictures (URLs or data URIs), which keep their face the same in every scene. */
export type CastPictures = { front: string; side: string };

/** Throws the first failure of a set of jobs: Stop as it is, a blocked picture or any other with the words given. */
function failure(results: PromiseSettledResult<unknown>[], done: number, words: string, what: string): void {
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (!failed) return;
  const stopped = results.find((r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof JobStopped);
  if (stopped) throw stopped.reason;
  console.error(`[flash] story ${what} failed`, failed.reason);
  if (failed.reason instanceof JobAbandoned && failed.reason.phrase === BLOCKED) {
    throw new FriendlyError(msg("The picture service's safety filter blocked part of this story. You only pay for what was made. Please change the words and try again."));
  }
  throw new FriendlyError(words, { failed: results.length - done, count: results.length });
}

/**
 * Paints each character of a new series twice, all at once: a front picture from their look and the
 * series' style, then the same person from the side, which Kling needs to keep a face the same.
 */
export async function paintCast(cast: StoryCharacter[], style: string, job: AdJob): Promise<{ pictures: CastPictures[]; cents: number }> {
  const t = job.t ?? english;
  const until = Date.now() + 240_000;
  let done = 0;
  const report = () => job.onProgress(t("Casting your characters… {done} of {count} done", { done, count: cast.length }));
  report();
  const results = await Promise.allSettled(
    cast.map(async (c) => {
      const front = await made(
        FACE,
        {
          prompt: `Film character photo of ${c.name}: ${c.look}. Front view, waist up, looking at the camera, neutral expression, plain soft background. ${style}. Photo-real, cinematic light, sharp face.`,
          image_size: STORY_FRAME.tall,
          output_format: "jpeg",
        },
        STORY_FACE_CENTS,
        job,
        until,
        "picture",
      );
      const side = await made(
        EDIT,
        {
          prompt: "The same person with exactly the same face, hair, skin and clothes, seen from a three-quarter side angle, full body, plain soft background.",
          image_urls: [front],
          image_size: STORY_FRAME.tall,
          output_format: "jpeg",
        },
        STORY_EDIT_CENTS,
        job,
        until,
        "picture",
      );
      done++;
      report();
      return { front, side };
    }),
  );
  failure(results, done, msg("{failed} of {count} characters couldn't be painted, so the story wasn't started. You only pay for what was made. Please try again."), "cast");
  return { pictures: results.map((r) => (r as PromiseFulfilledResult<CastPictures>).value), cents: cast.length * (STORY_FACE_CENTS + STORY_EDIT_CENTS) };
}

/**
 * Paints each scene's first frame at once, in the part's shape, with the characters in it made from
 * their front pictures, so they look the same as in every other scene.
 */
export async function paintScenes(
  plan: StoryPlan,
  scenes: StoryScene[],
  cast: StoryCharacter[],
  pictures: CastPictures[],
  style: string,
  job: AdJob,
): Promise<{ urls: string[]; cents: number }> {
  const t = job.t ?? english;
  const until = Date.now() + 240_000;
  let done = 0;
  let cents = 0;
  const report = () => job.onProgress(t("Painting the scenes… {done} of {count} done", { done, count: scenes.length }));
  report();
  const results = await Promise.allSettled(
    scenes.map(async (scene) => {
      const bound = sceneCast(scene, cast);
      const who = bound.map((i, at) => `image ${at + 1} is ${cast[i].name}`).join(", ");
      const prompt = `${scene.picture} ${who ? `Keep each person exactly as in their picture: ${who}.` : ""} ${style}. Photo-real film still, cinematic light.`;
      // A scene with none of the cast in it (a place, an object) is painted from its words alone.
      const url = bound.length
        ? await made(EDIT, { prompt, image_urls: bound.map((i) => pictures[i].front), image_size: STORY_FRAME[plan.shape], output_format: "jpeg" }, STORY_EDIT_CENTS, job, until, "picture")
        : await made(FACE, { prompt, image_size: STORY_FRAME[plan.shape], output_format: "jpeg" }, STORY_FACE_CENTS, job, until, "picture");
      cents += bound.length ? STORY_EDIT_CENTS : STORY_FACE_CENTS;
      done++;
      report();
      return url;
    }),
  );
  failure(results, done, msg("{failed} of {count} scenes couldn't be painted, so the part wasn't finished. You only pay for what was made. Please try again."), "scene");
  return { urls: results.map((r) => (r as PromiseFulfilledResult<string>).value), cents };
}

/**
 * Films each scene at once from its first frame, with its characters bound to their pictures and its
 * dialogue spoken with lip-sync, then joins the scenes, sound and all, into the part. Every scene must
 * be filmed. Returns the part and what it cost, in cents.
 */
export async function filmPart(
  plan: StoryPlan,
  scenes: StoryScene[],
  frames: string[],
  cast: StoryCharacter[],
  pictures: CastPictures[],
  style: string,
  job: AdJob,
): Promise<{ video: Media; cents: number }> {
  const t = job.t ?? english;
  const end = Date.now() + AD_WAIT_MS;
  const clipCents = STORY_CLIP_CENTS_PER_SECOND * plan.seconds;
  const began = Date.now();
  let filmed = 0;
  const report = () =>
    job.onProgress(
      t("Filming every scene at once, with the characters speaking… {done} of {count} done · {minutes} min so far (usually 4 to 9)", {
        done: filmed,
        count: frames.length,
        minutes: Math.floor((Date.now() - began) / 60_000),
      }),
    );
  report();
  const ticking = setInterval(report, 30_000);
  const results = await Promise.allSettled(
    frames.map(async (frame, i) => {
      const bound = sceneCast(scenes[i], cast);
      const url = await made(
        CLIP,
        {
          prompt: scenePrompt(scenes[i], cast, bound, style),
          start_image_url: frame,
          elements: bound.map((c) => ({ frontal_image_url: pictures[c].front, reference_image_urls: [pictures[c].side] })),
          duration: String(plan.seconds),
          aspect_ratio: { tall: "9:16", square: "1:1", wide: "16:9" }[plan.shape],
          generate_audio: true,
        },
        clipCents,
        job,
        end - JOIN_RESERVE_MS,
        "clip",
      );
      filmed++;
      report();
      return url;
    }),
  ).finally(() => clearInterval(ticking));
  failure(results, filmed, msg("{failed} of {count} scenes couldn't be filmed, so the part wasn't finished. You only pay for what was made. Please try again."), "clip");

  job.onProgress(t("Joining the scenes into your part…"));
  const urls = results.map((r) => (r as PromiseFulfilledResult<string>).value);
  const joined = await made(MERGE, { video_urls: urls }, STORY_JOIN_CENTS, job, end - 30_000, "merge");
  const video = await fetchMade(joined, "video/mp4").catch((err) => {
    console.error("[flash] story download failed", err);
    throw new JobAbandoned(msg("Flash couldn't fetch the result. Please try again."), true);
  });
  return { video, cents: frames.length * clipCents + STORY_JOIN_CENTS };
}
