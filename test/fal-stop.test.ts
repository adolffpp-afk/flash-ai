import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai's queue. Each job follows a script of statuses, one per status check, and
// stays on the last; cancelling answers with the job's cancel status.
type Job = { statuses: string[]; checks: number; cancelled: boolean; cancelStatus: number };
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
    if (kind === "status") {
      const status = job.statuses[Math.min(job.checks++, job.statuses.length - 1)];
      return json({ status, queue_position: 0 });
    }
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
const { JobStopped } = await import("../src/lib/engines/errors.ts");

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
