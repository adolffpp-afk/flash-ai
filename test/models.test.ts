import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, modelCredits, pickModel, requestedSeconds, type Provider } from "../src/lib/models.ts";
import { findFile } from "../src/lib/engines/fal.ts";

const all = new Set<Provider>(["openai", "elevenlabs", "fal"]);
const pick = (engine: "image" | "video" | "music", msg: string, set = all, requested?: string, preferred?: string) =>
  pickModel(engine, msg, set, requested, false, preferred)?.model.id ?? null;

test("defaults stay on the original three providers, with the cheaper FLUX.2 Pro ahead of GPT Image", () => {
  assert.equal(pick("image", "Draw a logo for a coffee shop"), "flux-2-pro");
  assert.equal(pick("video", "A video of ocean waves at sunset"), "veo-3.1");
  assert.equal(pick("music", "An upbeat jingle for a bakery"), "eleven-music");
});

test("requests that fit a fal model go to it", () => {
  assert.equal(pick("image", "A photorealistic portrait of an old fisherman"), "flux-2-pro");
  assert.equal(pick("video", "A chef talking to the camera about pasta, with sound"), "veo-3.1");
  assert.equal(pick("video", "A 12 second clip of a train crossing a bridge"), "kling-3");
  assert.equal(pick("music", "A pop song with lyrics about Toronto"), "minimax-music");
});

test("fal models are skipped without a fal key", () => {
  const noFal = new Set<Provider>(["openai", "elevenlabs"]);
  // GPT Image makes the pictures when it is the only image model set up.
  assert.equal(pick("image", "A realistic photo of a cat", noFal), "gpt-image");
  assert.equal(pick("image", "A realistic photo of a cat", noFal, "gpt-image"), "gpt-image");
  assert.equal(pick("music", "A song with vocals", noFal), "eleven-music");
});

test("fal alone covers image, video and music", () => {
  const onlyFal = new Set<Provider>(["fal"]);
  assert.equal(pick("image", "Draw a logo", onlyFal), "flux-2-pro");
  assert.equal(pick("video", "Waves at sunset", onlyFal), "veo-3.1");
  assert.equal(pick("music", "A calm beat", onlyFal), "minimax-music");
});

test("with fal.ai set up, GPT Image is only used when picked; with OpenAI alone, it makes every picture", () => {
  for (const msg of ["Draw a logo for a coffee shop", "A poster with the words OPEN LATE", "A cat"]) {
    assert.notEqual(pick("image", msg), "gpt-image");
    assert.notEqual(pick("image", msg, new Set<Provider>(["fal", "openai"])), "gpt-image");
    assert.equal(pick("image", msg, new Set<Provider>(["openai"])), "gpt-image");
  }
  // Still a post pack when one is asked for and fal.ai is there to paint it.
  assert.equal(pick("image", "a social media pack for my bakery"), "post-pack");
});

test("no provider means demo mode", () => {
  assert.equal(pick("video", "Waves", new Set()), null);
});

test("a model the user picked wins, if it is set up", () => {
  assert.equal(pick("video", "Waves at sunset", all, "kling-3"), "kling-3");
  assert.equal(pick("video", "Waves at sunset", new Set<Provider>(["openai"]), "kling-3"), null, "no video model without fal.ai");
  assert.equal(pick("image", "A logo", all, "veo-3.1"), "flux-2-pro");
  assert.equal(pick("image", "A logo", all, "gpt-image"), "gpt-image");
});

test("every video is made on fal.ai: the old video model is gone, and the default video model is set up there at its own price, which FLASH_VIDEO_MODEL can change", async () => {
  const videos = MODELS.filter((m) => m.engine === "video");
  assert.deepEqual(videos.map((m) => m.provider), videos.map(() => "fal"), "OpenAI's video API has ended");
  assert.ok(!MODELS.some((m) => /sora/i.test(`${m.id} ${m.label}`)));
  const { VIDEO_MODEL, defaultModel } = await import("../src/lib/engines/media.ts");
  assert.equal(VIDEO_MODEL, "veo-3.1");
  assert.equal(defaultModel("video"), "veo-3.1");
  assert.equal(defaultModel("image"), undefined);
  const veo = MODELS.find((m) => m.id === VIDEO_MODEL)!;
  // 8 seconds with sound at fal.ai's $0.40 a second, and the price shown everywhere is that one.
  assert.deepEqual([veo.provider, veo.costCents, veo.endpoint, modelCredits(veo)], ["fal", 320, "fal-ai/veo3.1", 801]);
  const onlyFal = new Set<Provider>(["fal"]);
  for (const set of [all, onlyFal]) assert.equal(pick("video", "Waves at sunset", set, undefined, VIDEO_MODEL), "veo-3.1");
  // FLASH_VIDEO_MODEL naming another video model makes it the default; matches and picks still win.
  assert.equal(pick("video", "Waves at sunset", all, undefined, "kling-3"), "kling-3");
  assert.equal(pick("video", "A chef talking to the camera, with sound", all, undefined, "kling-3"), "veo-3.1");
  assert.equal(pick("video", "Waves at sunset", all, "veo-3.1", "kling-3"), "veo-3.1");
  // One that isn't a video model Flash has (the old one, say) leaves the default, and never a chat-only one.
  for (const name of ["sora-2-pro", "sora-2", "movie", "kling-3-animate", "flux-2-pro"]) assert.equal(pick("video", "Waves at sunset", all, undefined, name), "veo-3.1", name);
  assert.equal(pick("video", "Waves at sunset", all, "sora-2-pro"), "veo-3.1", "a pick of the old model gets the default");
});

test("Video shows as working only with fal.ai set up, where every video model is: with OpenAI alone it is coming soon", async () => {
  const { engineStatus } = await import("../src/lib/server/status.ts");
  const keys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, FAL_KEY: process.env.FAL_KEY };
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.FAL_KEY;
    assert.deepEqual([engineStatus().video, pick("video", "Waves at sunset", new Set<Provider>(["openai"]))], [false, null]);
    assert.equal(engineStatus().image, true, "pictures still work with OpenAI");
    process.env.FAL_KEY = "k";
    assert.equal(engineStatus().video, true);
  } finally {
    for (const [key, value] of Object.entries(keys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("requestedSeconds reads and clamps durations", () => {
  assert.equal(requestedSeconds("a 12 second clip", 3, 15, 10), 12);
  assert.equal(requestedSeconds("a 30-second clip", 3, 15, 10), 15);
  assert.equal(requestedSeconds("a clip of waves", 3, 15, 10), 10);
});

test("findFile reads video, audio and image results", () => {
  assert.equal(findFile({ video: { url: "v.mp4" } })?.url, "v.mp4");
  assert.equal(findFile({ audio: { url: "a.mp3" } })?.url, "a.mp3");
  assert.equal(findFile({ images: [{ url: "i.png" }] })?.url, "i.png");
  assert.equal(findFile({ nothing: true }), null);
});

test("flagged reads fal's safety filter verdict", async () => {
  const { flagged } = await import("../src/lib/engines/fal.ts");
  assert.equal(flagged({ images: [], has_nsfw_concepts: [true] }), true);
  assert.equal(flagged({ images: [], has_nsfw_concepts: [false, true] }), true);
  assert.equal(flagged({ images: [], has_nsfw_concepts: [false] }), false);
  assert.equal(flagged({ images: [] }), false);
  assert.equal(flagged(null), false);
});
