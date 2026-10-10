import type { Media } from "./media.ts";
import type { Meter } from "./claude.ts";
import { falGenerate, falRun, findFile } from "./fal.ts";
import { FriendlyError, JobAbandoned } from "./errors.ts";
import { english, msg, type Translate } from "../i18n.ts";

const MERGE = process.env.FAL_MERGE_ENDPOINT || "fal-ai/ffmpeg-api/merge-videos";
// Kling 3 Turbo Pro, $0.14 a second (see the movie entry in src/lib/models.ts).
const CLIP_CENTS_PER_SECOND = 14;
// Writing the scenes and joining the clips, together.
export const MOVIE_EXTRA_CENTS = 2;

/** How long the whole movie may take, leaving time to save it before the request ends. */
export const MOVIE_WAIT_MS = 660_000;

/**
 * Films every scene at once on fal.ai, then joins the clips into one video.
 * Each clip is metered when it finishes (or is abandoned while running), so a movie that fails
 * part way only pays for the clips that were really filmed.
 */
export async function makeMovie(
  endpoint: string,
  scenes: string[],
  seconds: number,
  meter: Meter,
  onProgress: (message: string) => void,
  aspect = "16:9",
  // The language progress is reported in.
  t: Translate = english,
): Promise<Media> {
  const end = Date.now() + MOVIE_WAIT_MS;
  const clipCents = CLIP_CENTS_PER_SECOND * seconds;
  let done = 0;
  const report = () => onProgress(t("Filming your movie… {done} of {count} scenes done", { done, count: scenes.length }));
  report();

  const results = await Promise.allSettled(
    scenes.map(async (prompt) => {
      try {
        const { result } = await falRun(
          endpoint,
          { prompt, duration: String(seconds), aspect_ratio: aspect },
          () => {},
          // Leaves time to join the clips and save the movie.
          end - Date.now() - 120_000,
        );
        meter("fal", "movie-scene", clipCents);
        done++;
        report();
        const file = findFile(result);
        if (!file) throw new FriendlyError("A scene finished but sent nothing back.");
        return file.url;
      } catch (err) {
        if (err instanceof JobAbandoned && err.billed) meter("fal", "movie-scene", clipCents);
        throw err;
      }
    }),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    console.error("[flash] movie scene failed", failed.reason);
    throw new FriendlyError(
      msg("{failed} of {count} scenes couldn't be filmed, so the movie wasn't finished. You only pay for the scenes that were filmed. Please try again."),
      { failed: results.length - done, count: scenes.length },
    );
  }

  onProgress(t("Joining the scenes into one movie…"));
  const urls = results.map((r) => (r as PromiseFulfilledResult<string>).value);
  const movie = await falGenerate(MERGE, { video_urls: urls }, () => {}, Math.max(30_000, end - Date.now()));
  meter("fal", "movie-join", 0);
  return movie;
}
