import { test } from "node:test";
import assert from "node:assert/strict";
import { pickModel, requestedSeconds, type Provider } from "../src/lib/models.ts";
import { findFile } from "../src/lib/engines/fal.ts";

const all = new Set<Provider>(["openai", "elevenlabs", "fal"]);
const pick = (engine: "image" | "video" | "music", msg: string, set = all, requested?: string) =>
  pickModel(engine, msg, set, requested)?.model.id ?? null;

test("defaults stay on the original three providers, except the dearer GPT Image", () => {
  assert.equal(pick("image", "Draw a logo for a coffee shop"), "flux-2-pro");
  assert.equal(pick("video", "A video of ocean waves at sunset"), "sora-2-pro");
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
  assert.equal(pick("image", "A realistic photo of a cat", noFal), null);
  assert.equal(pick("image", "A realistic photo of a cat", noFal, "gpt-image"), "gpt-image");
  assert.equal(pick("music", "A song with vocals", noFal), "eleven-music");
});

test("fal alone covers image, video and music", () => {
  const onlyFal = new Set<Provider>(["fal"]);
  assert.equal(pick("image", "Draw a logo", onlyFal), "flux-2-pro");
  assert.equal(pick("video", "Waves at sunset", onlyFal), "veo-3.1");
  assert.equal(pick("music", "A calm beat", onlyFal), "minimax-music");
});

test("GPT Image is only used when picked, so an OpenAI key never makes it the default", () => {
  for (const msg of ["Draw a logo for a coffee shop", "A poster with the words OPEN LATE", "A cat"]) {
    assert.notEqual(pick("image", msg), "gpt-image");
    assert.notEqual(pick("image", msg, new Set<Provider>(["openai"])), "gpt-image");
  }
});

test("no provider means demo mode", () => {
  assert.equal(pick("video", "Waves", new Set()), null);
});

test("a model the user picked wins, if it is set up", () => {
  assert.equal(pick("video", "Waves at sunset", all, "kling-3"), "kling-3");
  assert.equal(pick("video", "Waves at sunset", new Set<Provider>(["openai"]), "kling-3"), "sora-2-pro");
  assert.equal(pick("image", "A logo", all, "veo-3.1"), "flux-2-pro");
  assert.equal(pick("image", "A logo", all, "gpt-image"), "gpt-image");
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
