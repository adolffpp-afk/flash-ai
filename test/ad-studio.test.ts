import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai: every job is done at the first look, and sends back what its kind of model
// makes. What was asked of it is kept, and a model named in failing fails.
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
      const endpoint = url.slice(1);
      const id = asked.push({ endpoint, input: JSON.parse(body) });
      return json({ status_url: `${base}/status/${id}`, response_url: `${base}/result/${id}`, cancel_url: `${base}/cancel/${id}` });
    }
    const [, kind, n] = url.split("/");
    const job = asked[Number(n) - 1];
    if (kind === "status") return json({ status: "COMPLETED" });
    if (kind === "result") {
      if (failing && job.endpoint.includes(failing)) return json({ detail: "failed" }, 500);
      const file = `${base}/file/${n}`;
      if (job.endpoint.includes("compose")) return json({ video_url: file, thumbnail_url: file });
      if (job.endpoint.includes("flux")) return json({ images: [{ url: file, content_type: "image/jpeg" }] });
      if (job.endpoint.includes("kling")) return json({ video: { url: file, content_type: "video/mp4" } });
      return json({ audio: { url: file, content_type: "audio/mpeg" } });
    }
    if (kind === "file") return res.writeHead(200, { "Content-Type": "video/mp4" }).end("MP4");
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.FAL_KEY = "k";
process.env.FAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const studio = await import("../src/lib/ad-studio.ts");
const { paintFrames, filmAd } = await import("../src/lib/engines/ad-studio.ts");
const { parseAd } = await import("../src/lib/engines/claude.ts");
const { modelById, modelCredits, pickModel } = await import("../src/lib/models.ts");
const { VOICES } = await import("../src/lib/voices.ts");
const { FriendlyError } = await import("../src/lib/engines/errors.ts");

const {
  adPlan,
  adRequest,
  adStep,
  adCostCents,
  adMadeCents,
  adStepCents,
  filmCents,
  filmRequest,
  fitVoiceover,
  readStoryboard,
  samePlan,
  storyboardCents,
  storyboardOf,
  AD_WRITER_CENTS,
} = studio;

const script = {
  title: "Golden hour",
  scenes: [
    { picture: "A perfume bottle on marble", motion: "Slow push in" },
    { picture: "A woman in a golden palace", motion: "Tracking shot" },
    { picture: "The bottle and the logo", motion: "Orbit" },
  ],
  voiceover: "L'or, la lumière, vous.",
  voice: "warm French woman",
  music: "Soft strings",
};

const job = () => {
  const spent: number[] = [];
  let started = 0;
  return {
    spent,
    startedCents: () => started,
    job: { meter: (_p: string, _m: string, cents: number) => void spent.push(cents), started: (c: number) => void (started += c), onProgress: () => {} },
  };
};

test("the Studio's choices are read back exactly, whatever the brief says", () => {
  const request = adRequest("A 60 second TikTok perfume ad, no music", { seconds: 15, shape: "square", voice: true, music: true });
  assert.deepEqual(adPlan(request), { scenes: 2, seconds: 8, shape: "square", voice: true, music: true });
  assert.deepEqual(adPlan(adRequest("ad", { seconds: 30, shape: "tall", voice: false, music: false })), { scenes: 3, seconds: 10, shape: "tall", voice: false, music: false });
  assert.deepEqual(adPlan(adRequest("ad", { seconds: 60, shape: "wide", voice: true, music: true })), { scenes: 6, seconds: 10, shape: "wide", voice: true, music: true });
  // Typed freely: 30 seconds, wide, with voice and music, unless it says otherwise.
  assert.deepEqual(adPlan("a commercial for my bakery"), { scenes: 3, seconds: 10, shape: "wide", voice: true, music: true });
  assert.deepEqual(adPlan("a 1 minute Instagram reel without music"), { scenes: 6, seconds: 10, shape: "tall", voice: true, music: false });
});

test("a storyboard comes first for a few credits, and filming it costs the rest of the whole ad", () => {
  const choices = { seconds: 30, shape: "tall" as const, voice: true, music: true };
  const board = adRequest("perfume", { ...choices, storyboard: true });
  const whole = adRequest("perfume", choices);
  assert.equal(adStep(board), "storyboard");
  assert.equal(adStep(whole), "whole");
  const plan = adPlan(whole);
  const film = filmRequest("abcdefgh12345678", plan);
  assert.equal(adStep(film), "film");
  assert.equal(storyboardOf(film), "abcdefgh12345678");
  assert.ok(samePlan(adPlan(film), plan), "filming is priced with the storyboard's own choices");
  assert.equal(adStepCents(board), storyboardCents(plan));
  assert.equal(adStepCents(film), filmCents(plan));
  assert.ok(Math.abs(storyboardCents(plan) + filmCents(plan) - adCostCents(plan)) < 1e-9);
  const ads = modelById("ad-studio")!;
  // About 65 credits to see it, about 1,060 at most for the whole 30 second ad (see the plan).
  assert.ok(modelCredits(ads, board) <= 65, `${modelCredits(ads, board)}`);
  assert.ok(modelCredits(ads, whole) <= 1060, `${modelCredits(ads, whole)}`);
  assert.ok(modelCredits(ads, adRequest("x", { seconds: 60, shape: "wide", voice: true, music: true })) <= 1960);
});

test("what an ad is charged as made is never more than its price", () => {
  for (const seconds of [15, 30, 60]) {
    for (const music of [true, false]) {
      const plan = adPlan(adRequest("x", { seconds, shape: "wide", voice: true, music }));
      const most = adCostCents(plan);
      for (const product of [true, false]) {
        const made = adMadeCents({ plan, scenes: plan.scenes, product, voiceChars: studio.adVoiceChars(plan), music });
        assert.ok(made <= most + 1e-9, `${seconds}s: ${made} > ${most}`);
      }
    }
  }
});

test("the Ads Studio is only picked when asked for, with a product photo or without", () => {
  const all = new Set(["fal", "openai", "elevenlabs"] as const);
  assert.equal(pickModel("video", "a commercial for my bakery", all)?.model.id === "ad-studio", false);
  assert.equal(pickModel("video", "a perfume ad", all, "ad-studio")?.model.id, "ad-studio");
  assert.equal(pickModel("video", "a perfume ad", all, "ad-studio", true)?.model.id, "ad-studio");
  // Others still need a photo to edit, or none.
  assert.notEqual(pickModel("video", "a perfume ad", all, "kling-3", true)?.model.id, "kling-3");
});

test("a voiceover is cut to fit the ad at the end of a sentence", () => {
  assert.equal(fitVoiceover("Short and sweet.", 100), "Short and sweet.");
  assert.equal(fitVoiceover("First sentence here. Second sentence that runs long.", 30), "First sentence here.");
  assert.ok(fitVoiceover("word ".repeat(100), 50).length <= 50);
});

test("the script is read from Claude's reply, and a broken one fails before anything is made", () => {
  const read = parseAd("```json\n" + JSON.stringify({ ...script, scenes: [...script.scenes, { picture: "extra", motion: "" }] }) + "\n```", 3);
  assert.equal(read.scenes.length, 3);
  assert.equal(read.voiceover, script.voiceover);
  assert.throws(() => parseAd("Sorry, I can't.", 3), FriendlyError);
});

test("a stored storyboard is read back only when it's whole", () => {
  const plan = adPlan(adRequest("x", { seconds: 30, shape: "wide", voice: true, music: true }));
  const board = { v: 1, plan, script, frames: ["a", "b", "c"] };
  assert.deepEqual(readStoryboard(JSON.stringify(board)), board);
  assert.equal(readStoryboard(JSON.stringify({ ...board, frames: ["a"] })), null);
  assert.equal(readStoryboard("not json"), null);
});

test("each scene's first frame is painted in the ad's shape, or made from the product photo", async () => {
  const plan = adPlan(adRequest("x", { seconds: 30, shape: "tall", voice: true, music: true }));
  asked.length = 0;
  const { job: j, spent } = job();
  const painted = await paintFrames(plan, script, null, j);
  assert.equal(painted.urls.length, 3);
  assert.ok(asked.every((a) => a.endpoint === "fal-ai/flux-2-pro"));
  assert.deepEqual(asked[0].input.image_size, { width: 720, height: 1280 });
  assert.equal(painted.cents, 3 * studio.AD_PICTURE_CENTS);
  assert.deepEqual(spent, [3, 3, 3]);

  asked.length = 0;
  const withPhoto = await paintFrames(plan, script, "data:image/png;base64,AAAA", job().job);
  assert.ok(asked.every((a) => a.endpoint === "fal-ai/flux-2/turbo/edit"));
  assert.deepEqual(asked[0].input.image_urls, ["data:image/png;base64,AAAA"]);
  assert.equal(withPhoto.cents, 3 * studio.AD_PRODUCT_PICTURE_CENTS);
});

test("an ad is filmed in 1080p scenes with its voiceover and music, joined in order, and charged as made", async () => {
  const plan = adPlan(adRequest("x", { seconds: 30, shape: "wide", voice: true, music: true }));
  asked.length = 0;
  const { job: j, spent } = job();
  const ad = await filmAd(plan, script, ["f1", "f2", "f3"], { voice: VOICES[0], speed: 1 }, j);
  assert.equal(ad.video.data.toString(), "MP4");
  const clips = asked.filter((a) => a.endpoint.includes("kling"));
  assert.deepEqual(clips.map((c) => c.input.start_image_url), ["f1", "f2", "f3"]);
  assert.ok(clips.every((c) => c.input.duration === "10" && c.input.generate_audio === false));
  const music = asked.find((a) => a.endpoint.includes("music"))!;
  assert.equal(music.input.music_length_ms, 30_000);
  assert.equal(music.input.force_instrumental, true);
  const join = asked.find((a) => a.endpoint.includes("compose"))!;
  const tracks = join.input.tracks as { id: string; keyframes: { timestamp: number; duration: number }[] }[];
  assert.deepEqual(tracks.map((t) => t.id), ["scenes", "voice", "music"]);
  assert.deepEqual(tracks[0].keyframes.map((k) => k.timestamp), [0, 10_000, 20_000]);
  // Charged what was metered, and within the price of filming.
  const metered = spent.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(ad.cents - metered) < 1e-9);
  assert.ok(ad.cents <= filmCents(plan));
  assert.equal(
    ad.cents + AD_WRITER_CENTS + 3 * studio.AD_PICTURE_CENTS,
    adMadeCents({ plan, scenes: 3, product: false, voiceChars: script.voiceover.length, music: true }),
  );
});

test("music that fails is left out and not charged; a scene that fails stops the ad", async () => {
  const plan = adPlan(adRequest("x", { seconds: 30, shape: "wide", voice: true, music: true }));
  failing = "music";
  const { job: j } = job();
  const ad = await filmAd(plan, script, ["f1", "f2", "f3"], { voice: VOICES[0], speed: 1 }, j);
  assert.equal(ad.music, false);
  assert.equal(ad.notes.length, 1);
  assert.ok(ad.cents <= filmCents(plan) - studio.adMusicCents(plan));

  failing = "kling";
  await assert.rejects(filmAd(plan, script, ["f1", "f2", "f3"], { voice: VOICES[0], speed: 1 }, job().job), FriendlyError);
  failing = "";
});

test("a video, ad or movie typed in the chat is spotted, and something to build isn't", () => {
  const { looksLikeFilm, adSecondsOf } = studio;
  for (const yes of [
    "A cinematic fantasy trailer. A red-haired warrior queen holds a newborn baby. Scenes: the palace at dawn, enemies arriving. Epic orchestral music, a deep English narrator.",
    "Make a 30 second ad for my bakery",
    "a commercial for my shoe shop",
    "create a video of a cat surfing",
    "A short film about two robots falling in love, three scenes, soft piano music",
    "TikTok reel for my perfume, 15 seconds",
  ]) assert.ok(looksLikeFilm(yes), yes);
  for (const no of [
    "Build a movie review app",
    "A website for my film studio with a cinematic look",
    "a landing page for my video agency",
    "what is the best movie of 2025?",
    "write a poem about the sea",
    "make the button blue",
    "add a dashboard",
    "a presentation about advertising",
  ]) assert.ok(!looksLikeFilm(no), no);
  assert.equal(adSecondsOf("a one minute trailer"), 60);
  assert.equal(adSecondsOf("a 15 second ad"), 15);
  assert.equal(adSecondsOf("a trailer"), 30);
});
