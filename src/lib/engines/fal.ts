import type { Media } from "./media.ts";
import { msg } from "../i18n.ts";
import { FriendlyError, MEDIA_WAIT_MS, JobAbandoned } from "./errors.ts";

// fal.ai runs hundreds of image, video and music models behind one key and one queue API.
const FAL_QUEUE = process.env.FAL_BASE_URL || "https://queue.fal.run";

export const falConfigured = () => Boolean(process.env.FAL_KEY);
const headers = () => ({ Authorization: `Key ${process.env.FAL_KEY}` });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function failure(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`The model service returned ${res.status}: ${body.slice(0, 300)}`);
}

type FileRef = { url: string; content_type?: string };

/** Finds the generated file in a fal result: { video }, { audio }, { images: [...] } and similar. */
export function findFile(result: unknown): FileRef | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  for (const key of ["video", "audio", "audio_file", "image", "images", "file"]) {
    const v = Array.isArray(r[key]) ? (r[key] as unknown[])[0] : r[key];
    if (v && typeof v === "object" && typeof (v as FileRef).url === "string") return v as FileRef;
  }
  return null;
}

/** Where a job is: its place in line (1 is next) while it waits, or null once it's working. */
export type FalProgress = { position: number | null };
/** Short English updates ("In line (position 2)", "Working"), and where the job is, to say it in the user's language. */
export type OnFalProgress = (message: string, progress: FalProgress) => void;

/**
 * Runs a fal model through its queue and returns its JSON result, all within timeoutMs so the
 * request always ends in time to settle credits.
 * onProgress receives short updates ("In line…", "Working…") while it waits.
 */
export async function falRun(
  endpoint: string,
  input: Record<string, unknown>,
  onProgress: OnFalProgress = () => {},
  timeoutMs = MEDIA_WAIT_MS,
): Promise<{ result: unknown; end: number }> {
  const end = Date.now() + timeoutMs;
  const submit = await fetch(`${FAL_QUEUE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers() },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submit.ok) throw await failure(submit);
  const job = (await submit.json()) as { status_url: string; response_url: string; cancel_url?: string };

  // Leaves time to fetch and download the result.
  const deadline = end - 30_000;
  let queued = true;
  for (;;) {
    if (Date.now() > deadline) {
      // A job still in line can be cancelled; one already running will be billed anyway.
      if (queued && job.cancel_url) await fetch(job.cancel_url, { method: "PUT", headers: headers() }).catch(() => {});
      throw new JobAbandoned(msg("This is taking too long, so Flash stopped waiting. Please try again."), !queued);
    }
    const poll = await fetch(job.status_url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (!poll.ok) throw await failure(poll);
    const status = (await poll.json()) as { status: string; queue_position?: number };
    if (status.status === "COMPLETED") break;
    queued = status.status === "IN_QUEUE";
    const position = queued ? (status.queue_position ?? 0) + 1 : null;
    onProgress(position === null ? "Working" : `In line (position ${position})`, { position });
    await sleep(queued ? 3000 : 1500);
  }

  // The job is finished and billed from here on, even if fetching the result fails.
  try {
    const res = await fetch(job.response_url, { headers: headers(), signal: timeLeft(end) });
    if (!res.ok) throw await failure(res);
    return { result: await res.json(), end };
  } catch (err) {
    throw billed(err);
  }
}

const timeLeft = (end: number) => AbortSignal.timeout(Math.max(1000, end - Date.now()));

// fal's synchronous endpoint answers on the same request, with no queue to poll (polling adds 1.5
// to 3 seconds). For short jobs someone is waiting on, like a spoken turn. Never used in place of a
// FAL_BASE_URL that points elsewhere (a test double or a proxy): set FAL_SYNC_URL too for that.
const falSync = () => process.env.FAL_SYNC_URL || (process.env.FAL_BASE_URL ? "" : "https://fal.run");
export const falSyncConfigured = () => Boolean(falSync());

/** Runs a short fal job and returns its JSON result. A job that timed out may have run, so it counts as billed. */
export async function falRunNow(endpoint: string, input: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${falSync()}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new JobAbandoned(msg("This is taking too long, so Flash stopped waiting. Please try again."), true);
    throw err;
  }
  if (!res.ok) throw await failure(res);
  try {
    return await res.json();
  } catch (err) {
    throw billed(err);
  }
}

function billed(err: unknown): JobAbandoned {
  console.error("[flash] fal result failed", err);
  return err instanceof FriendlyError
    ? new JobAbandoned(err.phrase, true, err.blanks)
    : new JobAbandoned(msg("Flash couldn't fetch the result. Please try again."), true);
}

/** Runs a fal model that makes a file (an image, video or audio) and downloads the file. */
export async function falGenerate(
  endpoint: string,
  input: Record<string, unknown>,
  onProgress: OnFalProgress = () => {},
  timeoutMs = MEDIA_WAIT_MS,
): Promise<Media> {
  const { result, end } = await falRun(endpoint, input, onProgress, timeoutMs);
  try {
    const file = findFile(result);
    if (!file) throw new FriendlyError(msg("The model finished but sent nothing back. Please try again."));
    const download = await fetch(file.url, { signal: timeLeft(end) });
    if (!download.ok) throw await failure(download);
    return {
      data: Buffer.from(await download.arrayBuffer()),
      mime: file.content_type || download.headers.get("content-type") || "application/octet-stream",
    };
  } catch (err) {
    throw billed(err);
  }
}
