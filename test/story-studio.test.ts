import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai, as in ad-studio.test.ts: every job is done at the first look and sends back
// what its kind of model makes; a model named in failing fails.
const asked: { endpoint: string; input: Record<string, unknown> }[] = [];
let failing = "";
const server = createServer((req, res) => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = (v: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url!;
    if (req.method === "POST") {
      const id = asked.push({ endpoint: url.slice(1), input: JSON.parse(body) });
      return json({ status_url: `${base}/status/${id}`, response_url: `${base}/result/${id}`, cancel_url: `${base}/cancel/${id}` });
    }
    const [, kind, n] = url.split("/");
    const job = asked[Number(n) - 1];
    if (kind === "status") return json({ status: "COMPLETED" });
    if (kind === "result") {
      if (failing && job.endpoint.includes(failing)) return json({ detail: "failed" }, 500);
      const file = `${base}/file/${n}`;
      if (job.endpoint.includes("flux")) return json({ images: [{ url: file, content_type: "image/jpeg" }] });
      return json({ video: { url: file, content_type: "video/mp4" } });
    }
    if (kind === "file") return res.writeHead(200, { "Content-Type": "video/mp4" }).end("MP4");
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.FAL_KEY = "k";
process.env.FAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const story = await import("../src/lib/story-studio.ts");
const { paintCast, paintScenes, filmPart } = await import("../src/lib/engines/story-studio.ts");
const { parseStory } = await import("../src/lib/engines/claude.ts");
const { modelById, modelCredits, pickModel } = await import("../src/lib/models.ts");
const { FriendlyError } = await import("../src/lib/engines/errors.ts");

const {
  storyPlan,
  storyRequest,
  storyStep,
  storyBoardOf,
  storyBoardCents,
  storyFilmCents,
  filmPartRequest,
  nextPartRequest,
  readSeries,
  readStoryBoard,
  sameStoryPlan,
  sceneCast,
  scenePrompt,
  looksLikeStory,
} = story;

const cast = [
  { name: "Amara", look: "a 28 year old Nigerian nurse, short braids, blue scrubs", voice: "soft young woman" },
  { name: "Daniel", look: "a 35 year old man, tall, grey suit", voice: "deep calm man" },
];
const scenes = [
  { picture: "Amara in a hospital corridor at night", action: "Amara walks fast, the camera follows her.", lines: [{ who: "Amara", line: "Not tonight." }] },
  { picture: "Daniel in a glass office", action: "Daniel turns to face Amara.", lines: [{ who: "Daniel", line: "You came back." }, { who: "Amara", line: "For my patients." }] },
  { picture: "The empty hospital at dawn", action: "Slow drone shot over the roof.", lines: [{ who: "Narrator", line: "Some doors never close." }] },
];
const job = () => {
  const spent: number[] = [];
  return { spent, job: { meter: (_p: string, _m: string, cents: number) => void spent.push(cents), started: () => {}, onProgress: () => {} } };
};

test("a part's choices, its steps and its series are read back from its request", () => {
  assert.deepEqual(storyPlan(storyRequest("A nurse meets her ex", { seconds: 60, shape: "tall" })), { scenes: 6, seconds: 10, shape: "tall", fast: false, part: 1, series: null });
  assert.deepEqual(storyPlan(storyRequest("x", { seconds: 90, shape: "wide" })), { scenes: 9, seconds: 10, shape: "wide", fast: false, part: 1, series: null });
  assert.deepEqual(storyPlan("a 30 second drama"), { scenes: 3, seconds: 10, shape: "tall", fast: false, part: 1, series: null });
  const plan = storyPlan(storyRequest("x", { seconds: 60, shape: "tall" }));
  const next = nextPartRequest("series12345678", 2, plan);
  assert.deepEqual(storyPlan(next), { ...plan, part: 2, series: "series12345678" });
  assert.equal(storyStep(next), "board");
  const film = filmPartRequest("board12345678", storyPlan(next));
  assert.equal(storyStep(film), "film");
  assert.equal(storyBoardOf(film), "board12345678");
  assert.ok(sameStoryPlan(storyPlan(film), storyPlan(next)));
  assert.deepEqual(storyPlan(film), storyPlan(next));
  // Fast stays fast for the film and the next part.
  const quick = storyPlan(storyRequest("x", { seconds: 60, shape: "tall", fast: true }));
  assert.equal(quick.fast, true);
  assert.equal(storyPlan(filmPartRequest("board12345678", quick)).fast, true);
  assert.equal(storyPlan(nextPartRequest("series12345678", 2, quick)).fast, true);
  assert.ok(!sameStoryPlan(quick, plan));
});

test("a storyboard is cheap, a next part needs no new cast, and filming is priced at Kling's rate with sound", () => {
  const stories = modelById("story-studio")!;
  const first = storyRequest("x", { seconds: 60, shape: "tall" });
  const plan = storyPlan(first);
  assert.equal(storyBoardCents(plan), 3 + 4 * 10 + 6 * 7);
  assert.equal(storyBoardCents({ ...plan, series: "s" }), 3 + 6 * 7);
  assert.equal(storyFilmCents(plan), 60 * 14 + 1);
  assert.ok(modelCredits(stories, first) <= 215, `${modelCredits(stories, first)}`);
  assert.ok(modelCredits(stories, filmPartRequest("board12345678", plan)) <= 2105);
  // Fast (Kling O3 Standard, $0.112 a second) costs less, and the same storyboard.
  const quick = { ...plan, fast: true };
  assert.equal(storyFilmCents(quick), 60 * 12 + 1);
  assert.equal(storyBoardCents(quick), storyBoardCents(plan));
  assert.ok(modelCredits(stories, filmPartRequest("board12345678", quick)) < modelCredits(stories, filmPartRequest("board12345678", plan)));
  // Only from the Studio.
  const all = new Set(["fal", "openai", "elevenlabs"] as const);
  assert.notEqual(pickModel("video", "a drama about a nurse", all)?.model.id, "story-studio");
  assert.equal(pickModel("video", "a drama about a nurse", all, "story-studio")?.model.id, "story-studio");
});

test("each scene binds the characters in it, and speaks each line in that character's voice", () => {
  assert.deepEqual(sceneCast(scenes[1], cast), [0, 1]);
  assert.deepEqual(sceneCast(scenes[2], cast), []);
  const prompt = scenePrompt(scenes[1], cast, [0, 1], "warm hospital light");
  assert.match(prompt, /@Element2 \(Daniel\) turns to face @Element1 \(Amara\)/);
  assert.match(prompt, /@Element2 says in a deep calm man voice: "You came back\."/);
  assert.match(prompt, /@Element1 says in a soft young woman voice: "For my patients\."/);
  assert.match(scenePrompt(scenes[2], cast, [], ""), /off screen says: "Some doors never close\."/);
});

test("the story is read from Claude's reply, and a broken one fails before anything is made", () => {
  const read = parseStory(JSON.stringify({ title: "Second chance", style: "warm", cast, part: { title: "The return", summary: "She meets him", scenes } }), 3);
  assert.equal(read.cast.length, 2);
  assert.equal(read.part.scenes.length, 3);
  assert.equal(read.part.scenes[1].lines.length, 2);
  assert.throws(() => parseStory(JSON.stringify({ part: { scenes: scenes.slice(0, 1) } }), 3), FriendlyError);
  assert.throws(() => parseStory("Sorry.", 3), FriendlyError);
});

test("a series and a storyboard are read back only when whole", () => {
  const series = { v: 1, title: "T", style: "s", shape: "tall", cast: cast.map((c) => ({ ...c, front: "f", side: "s" })), parts: [] };
  assert.deepEqual(readSeries(JSON.stringify(series)), series);
  assert.equal(readSeries(JSON.stringify({ ...series, cast: [{ name: "A" }] })), null);
  const plan = storyPlan("a 30 second drama");
  const board = { v: 1, plan, series, part: { title: "", summary: "", scenes }, frames: ["a", "b", "c"] };
  assert.deepEqual(readStoryBoard(JSON.stringify(board)), board);
  assert.equal(readStoryBoard(JSON.stringify({ ...board, frames: ["a"] })), null);
});

test("the cast is painted front and side, and each scene with its characters from their pictures", async () => {
  asked.length = 0;
  const { job: j, spent } = job();
  const painted = await paintCast(cast, "warm", j);
  assert.equal(painted.pictures.length, 2);
  assert.equal(asked.filter((a) => a.endpoint === "fal-ai/flux-2-pro").length, 2);
  const sides = asked.filter((a) => a.endpoint === "fal-ai/flux-2/turbo/edit");
  assert.deepEqual(sides.map((a) => a.input.image_urls), painted.pictures.map((p) => [p.front]));
  assert.equal(painted.cents, 20);
  assert.equal(spent.reduce((a, b) => a + b, 0), 20);

  asked.length = 0;
  const plan = storyPlan("a 30 second drama");
  const frames = await paintScenes(plan, scenes, cast, painted.pictures, "warm", job().job);
  assert.equal(frames.urls.length, 3);
  const both = asked.find((a) => (a.input.prompt as string).startsWith("Daniel in a glass office"))!;
  assert.deepEqual(both.input.image_urls, [painted.pictures[0].front, painted.pictures[1].front]);
  assert.deepEqual(both.input.image_size, { width: 720, height: 1280 });
  // The empty hospital has none of the cast, so it's painted from its words, for less.
  assert.equal(asked.find((a) => (a.input.prompt as string).startsWith("The empty hospital"))!.endpoint, "fal-ai/flux-2-pro");
  assert.equal(frames.cents, 7 + 7 + 3);
  assert.ok(frames.cents <= storyBoardCents({ ...plan, series: "s" }) - 3);
});

test("a part is filmed scene by scene with the cast bound and its own sound, joined in order, and charged as made", async () => {
  const plan = storyPlan("a 30 second drama");
  const pictures = cast.map((_, i) => ({ front: `front${i}`, side: `side${i}` }));
  asked.length = 0;
  const { job: j, spent } = job();
  const part = await filmPart(plan, scenes, ["f1", "f2", "f3"], cast, pictures, "warm", j);
  assert.equal(part.video.data.toString(), "MP4");
  const clips = asked.filter((a) => a.endpoint.includes("kling"));
  assert.deepEqual(clips.map((c) => c.input.start_image_url), ["f1", "f2", "f3"]);
  assert.ok(clips.every((c) => c.endpoint === "fal-ai/kling-video/o3/pro/reference-to-video" && c.input.generate_audio === true && c.input.duration === "10" && c.input.aspect_ratio === "9:16"));
  assert.deepEqual(clips[1].input.elements, [
    { frontal_image_url: "front0", reference_image_urls: ["side0"] },
    { frontal_image_url: "front1", reference_image_urls: ["side1"] },
  ]);
  const join = asked.find((a) => a.endpoint.includes("merge"))!;
  assert.equal((join.input.video_urls as string[]).length, 3);
  assert.equal(part.cents, spent.reduce((a, b) => a + b, 0));
  assert.equal(part.cents, storyFilmCents(plan));

  asked.length = 0;
  // Each scene is shown as soon as it's filmed, before the part is joined.
  const shown: number[] = [];
  const quick = await filmPart({ ...plan, fast: true }, scenes, ["f1", "f2", "f3"], cast, pictures, "warm", { ...job().job, onClip: (i: number) => void shown.push(i) });
  assert.deepEqual(shown.sort(), [0, 1, 2]);
  assert.ok(asked.filter((a) => a.endpoint.includes("kling")).every((c) => c.endpoint === "fal-ai/kling-video/o3/standard/reference-to-video"));
  assert.equal(quick.cents, storyFilmCents({ ...plan, fast: true }));

  failing = "kling";
  await assert.rejects(filmPart(plan, scenes, ["f1", "f2", "f3"], cast, pictures, "warm", job().job), FriendlyError);
  failing = "";
});

test("a drama typed in the chat goes to Story mode, and an ad to the Ads Studio", () => {
  assert.ok(looksLikeStory("A cinematic fantasy trailer. A red-haired warrior queen... Scenes: the palace at dawn"));
  assert.ok(looksLikeStory("Make a drama about a nurse and her ex, part 1"));
  assert.ok(!looksLikeStory("Make a 30 second ad for my bakery"));
  assert.ok(!looksLikeStory("a commercial for my shoe shop, three scenes"));
});
