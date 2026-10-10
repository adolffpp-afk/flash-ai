import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai's queue. Each job follows a script of statuses, one per status check, and
// stays on the last; cancelling answers with the job's cancel status. What a cancelled job shows
// next isn't written down by fal, so each way is tried: "error" (done, with no result), "gone"
// (fal no longer knows it), "cancelled" (a status of its own), "queued" (still shown in line) or
// "runs" (fal had picked it up, so it goes on with its script).
type AfterCancel = "error" | "gone" | "cancelled" | "queued" | "runs";
type Job = { statuses: string[]; checks: number; cancelled: boolean; cancelStatus: number; afterCancel?: AfterCancel };
const jobs: Job[] = [];
let script: Omit<Job, "checks" | "cancelled"> = { statuses: ["IN_QUEUE"], cancelStatus: 202 };
const server = createServer((req, res) => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (v: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
  req.resume();
  req.on("end", () => {
    const [, kind, n] = req.url!.split("/");
    const job = jobs[Number(n) - 1];
    if (req.method === "POST") {
      const id = jobs.push({ ...script, checks: 0, cancelled: false });
      return json({ status_url: `${base}/status/${id}`, response_url: `${base}/result/${id}`, cancel_url: `${base}/cancel/${id}` });
    }
    if (kind === "cancel") {
      job.cancelled = job.cancelStatus < 300;
      return json({ status: job.cancelled ? "CANCELLATION_REQUESTED" : "ALREADY_COMPLETED" }, job.cancelStatus);
    }
    const after: AfterCancel = job?.cancelled ? (job.afterCancel ?? "error") : "runs";
    if (after === "gone" && (kind === "status" || kind === "result")) return json({ detail: "Request not found" }, 404);
    if (kind === "status") {
      const scripted = job.statuses[Math.min(job.checks++, job.statuses.length - 1)];
      const shown: Record<AfterCancel, string> = { error: "COMPLETED", gone: "", cancelled: "CANCELLED", queued: "IN_QUEUE", runs: scripted };
      const status = shown[after];
      return json({ status, queue_position: 0 });
    }
    if (kind === "result" && after === "error") return json({ detail: "Request was cancelled" }, 400);
    if (kind === "result") return json({ image: { url: `${base}/file/${n}`, content_type: "image/png" } });
    if (kind === "file") return res.writeHead(200, { "Content-Type": "image/png" }).end("PNG");
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.FAL_KEY = "k";
process.env.FAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { falGenerate } = await import("../src/lib/engines/fal.ts");
const { JobAbandoned, JobStopped } = await import("../src/lib/engines/errors.ts");

test("Stop takes a job still waiting in line out of fal's queue, at once and for free", async () => {
  script = { statuses: ["IN_QUEUE"], cancelStatus: 202 };
  const stop = new AbortController();
  const started = Date.now();
  const made = falGenerate("fal-ai/flux", { prompt: "a cat" }, () => {}, 60_000, stop.signal);
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(made, (err) => err instanceof JobStopped);
  assert.equal(jobs.at(-1)!.cancelled, true);
  assert.ok(Date.now() - started < 2500, "without waiting out the 3 second pause");
});

test("Stop on a job fal has started lets it finish, and its result is delivered", async () => {
  script = { statuses: ["IN_PROGRESS", "IN_PROGRESS", "COMPLETED"], cancelStatus: 202 };
  const stop = new AbortController();
  stop.abort();
  const media = await falGenerate("fal-ai/flux", { prompt: "a dog" }, () => {}, 60_000, stop.signal);
  assert.equal(media.data.toString(), "PNG");
  assert.equal(jobs.at(-1)!.cancelled, false, "never cancelled");
});

test("a job that started just as Stop was pressed (the cancel isn't taken) is finished as usual", async () => {
  script = { statuses: ["IN_QUEUE", "COMPLETED"], cancelStatus: 400 };
  const stop = new AbortController();
  stop.abort();
  const media = await falGenerate("fal-ai/flux", { prompt: "a bird" }, () => {}, 60_000, stop.signal);
  assert.equal(media.data.toString(), "PNG");
});

test("without Stop a job in line is waited for", async () => {
  script = { statuses: ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"], cancelStatus: 202 };
  const media = await falGenerate("fal-ai/flux", { prompt: "a fish" }, () => {}, 60_000);
  assert.equal(media.data.toString(), "PNG");
  assert.equal(jobs.at(-1)!.cancelled, false);
});

test("a cancel fal took, on a job it had just picked up, still delivers the job and charges it", async () => {
  script = { statuses: ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"], cancelStatus: 202, afterCancel: "runs" };
  const stop = new AbortController();
  stop.abort();
  const media = await falGenerate("fal-ai/flux", { prompt: "a horse" }, () => {}, 60_000, stop.signal);
  assert.equal(media.data.toString(), "PNG");
  assert.equal(jobs.at(-1)!.cancelled, true, "the cancel was taken, and the job ran anyway");
});

test("a cancelled job fal no longer has, or shows as cancelled, never ran", async () => {
  for (const afterCancel of ["gone", "cancelled"] as const) {
    script = { statuses: ["IN_QUEUE"], cancelStatus: 202, afterCancel };
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(falGenerate("fal-ai/flux", { prompt: "a cow" }, () => {}, 60_000, stop.signal), (err) => err instanceof JobStopped, afterCancel);
  }
});

test("a cancelled job still shown in line is never charged, even when time runs out first", async () => {
  script = { statuses: ["IN_QUEUE"], cancelStatus: 202, afterCancel: "queued" };
  const stop = new AbortController();
  stop.abort();
  // 31.5 seconds in all leaves 1.5 seconds of waiting once the result's 30 are kept aside.
  const made = falGenerate("fal-ai/flux", { prompt: "a goat" }, () => {}, 31_500, stop.signal);
  await assert.rejects(made, (err) => (err instanceof JobStopped || err instanceof JobAbandoned) && !(err as { billed?: boolean }).billed);
});
