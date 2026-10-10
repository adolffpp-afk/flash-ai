import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai: scenes and the join finish on the first status check.
// A prompt containing "FAIL" makes that scene fail.
const submitted: { endpoint: string; body: Record<string, unknown> }[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (v: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "POST") {
      const body = JSON.parse(raw);
      const n = submitted.push({ endpoint: req.url!.slice(1), body });
      return json({ status_url: `${base}/status/${n}`, response_url: `${base}/result/${n}` });
    }
    if (req.url!.startsWith("/status/")) return json({ status: "COMPLETED" });
    if (req.url!.startsWith("/result/")) {
      const job = submitted[Number(req.url!.split("/")[2]) - 1];
      if (String(job.body.prompt ?? "").includes("FAIL")) return json({ detail: "failed" }, 500);
      if (job.endpoint.includes("merge")) return json({ video: { url: `${base}/movie.mp4`, content_type: "video/mp4" } });
      return json({ video: { url: `${base}/clip/${submitted.length}.mp4` } });
    }
    if (req.url === "/movie.mp4") return res.writeHead(200, { "Content-Type": "video/mp4" }).end("MOVIE");
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.FAL_KEY = "k";
process.env.FAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { makeMovie } = await import("../src/lib/engines/movie.ts");
const { parseScenes } = await import("../src/lib/engines/claude.ts");
const { MODELS, movieSeconds, movieScenes, movieSplit, modelCredits, pickModel, requestCents } = await import("../src/lib/models.ts");

test("a movie's length and scenes come from the request", () => {
  assert.equal(movieSeconds("make a movie about a lost cat"), 40);
  assert.equal(movieSeconds("a 1 minute movie about pirates"), 60);
  assert.equal(movieSeconds("a 30 second short film"), 30);
  assert.equal(movieSeconds("a 10 minute movie"), 90, "capped at 90 seconds");
  assert.deepEqual(movieScenes(60), { scenes: 6, seconds: 10 });
  const movie = MODELS.find((m) => m.id === "movie")!;
  // Every scene at Kling's price, with the markup, so a movie never runs at a loss.
  assert.ok(modelCredits(movie, "a 1 minute movie") >= Math.ceil((60 * 14 + 2) * 2.5));
});

test("a movie is priced on exactly the scenes it films, at every length", () => {
  const movie = MODELS.find((m) => m.id === "movie")!;
  const asks = [
    ...Array.from({ length: 80 }, (_, i) => `a ${i + 20} second movie about a lighthouse`),
    ...["0.5", "0.9", "1", "1.1", "1.4", "1.5", "one", "two"].map((n) => `a ${n} minute movie`),
    "make a movie about a lost cat",
  ];
  for (const ask of asks) {
    // What run() films is this split, as it is, and the price is that many seconds of Kling plus the writing.
    const { scenes, seconds } = movieSplit(ask);
    assert.equal(movieSeconds(ask), scenes * seconds, ask);
    assert.equal(requestCents(movie, ask), 14 * scenes * seconds + 2, ask);
    assert.ok(scenes >= 2 && seconds >= 5 && seconds <= 15, ask);
  }
  // The cases the review found: 75 seconds was priced as 72 and filmed as 70; 74 was priced as 77 and filmed as 80.
  assert.deepEqual(movieSplit("a 75 second movie"), movieScenes(75));
  assert.equal(requestCents(movie, "a 74 second movie"), 14 * movieSeconds("a 74 second movie") + 2);
});

test("only movie requests go to the Movie maker, and it is never the default", () => {
  const fal = new Set(["fal"] as const);
  assert.equal(pickModel("video", "make a short film about a robot", fal)?.model.id, "movie");
  assert.equal(pickModel("video", "a movie with music about a dancer", fal)?.model.id, "movie");
  assert.notEqual(pickModel("video", "a cinematic clip of waves", fal)?.model.id, "movie");
  assert.notEqual(pickModel("video", "a dog running on a beach", fal)?.model.id, "movie");
});

test("the scene list is read from a fenced reply", () => {
  assert.deepEqual(parseScenes('```json\n["A", "B", "C"]\n```', 2), ["A", "B"]);
  assert.throws(() => parseScenes("Sorry, I can't.", 3));
});

test("every scene is filmed, metered, and joined in order", async () => {
  submitted.length = 0;
  const spent: number[] = [];
  const steps: string[] = [];
  const movie = await makeMovie("kling", ["one", "two", "three"], 10, (_p, _m, c) => spent.push(c), (m) => steps.push(m));
  assert.equal(movie.data.toString(), "MOVIE");
  assert.deepEqual(spent, [140, 140, 140, 0]);
  const join = submitted.find((s) => s.endpoint.includes("merge"))!;
  assert.equal((join.body.video_urls as string[]).length, 3);
  assert.equal(submitted.filter((s) => s.endpoint === "kling").every((s) => s.body.duration === "10"), true);
  assert.ok(steps.some((s) => s.includes("3 of 3")));
});

test("a failed scene stops the movie and only filmed scenes are paid for", async () => {
  submitted.length = 0;
  const spent: number[] = [];
  await assert.rejects(
    makeMovie("kling", ["one", "FAIL two"], 10, (_p, _m, c) => spent.push(c), () => {}),
    /1 of 2 scenes couldn't be filmed/,
  );
  // The failed scene ran (its result couldn't be fetched), so fal bills it too.
  assert.deepEqual(spent, [140, 140]);
});
