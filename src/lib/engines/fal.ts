import type { Media } from "./media.ts";

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

/**
 * Runs a fal model through its queue and downloads the result.
 * onProgress receives short updates ("In line…", "Working…") while it waits.
 */
export async function falGenerate(
  endpoint: string,
  input: Record<string, unknown>,
  onProgress: (message: string) => void = () => {},
  timeoutMs = 12 * 60 * 1000,
): Promise<Media> {
  const submit = await fetch(`${FAL_QUEUE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers() },
    body: JSON.stringify(input),
  });
  if (!submit.ok) throw await failure(submit);
  const job = (await submit.json()) as { status_url: string; response_url: string };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("This is taking too long. Please try again.");
    const poll = await fetch(job.status_url, { headers: headers() });
    if (!poll.ok) throw await failure(poll);
    const status = (await poll.json()) as { status: string; queue_position?: number };
    if (status.status === "COMPLETED") break;
    onProgress(status.status === "IN_QUEUE" ? `In line (position ${(status.queue_position ?? 0) + 1})` : "Working");
    await sleep(3000);
  }

  const res = await fetch(job.response_url, { headers: headers() });
  if (!res.ok) throw await failure(res);
  const file = findFile(await res.json());
  if (!file) throw new Error("The model finished but sent nothing back.");
  const download = await fetch(file.url);
  if (!download.ok) throw await failure(download);
  return {
    data: Buffer.from(await download.arrayBuffer()),
    mime: file.content_type || download.headers.get("content-type") || "application/octet-stream",
  };
}
