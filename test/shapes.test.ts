import { test } from "node:test";
import assert from "node:assert/strict";
import { falInput, shapeOf, videoAspect } from "../src/lib/engines/fal-input.ts";
import { MODELS } from "../src/lib/models.ts";

const model = (id: string) => MODELS.find((m) => m.id === id)!;

test("requests pick a picture shape from plain words", () => {
  assert.equal(shapeOf("A sunset for my Instagram story"), "tall");
  assert.equal(shapeOf("vertical phone wallpaper of a forest"), "tall");
  assert.equal(shapeOf("A movie poster for a space western"), "portrait");
  assert.equal(shapeOf("Logo for a bakery called Crumb"), "square");
  assert.equal(shapeOf("profile picture of a smiling cat, 1:1"), "square");
  assert.equal(shapeOf("A YouTube thumbnail about cooking"), "wide");
  assert.equal(shapeOf("A banner for my shop, 16:9"), "wide");
  // Ordinary words that aren't about shape leave the usual 4:3.
  assert.equal(shapeOf("A tall man telling a story to a wide-eyed child"), null);
  assert.equal(shapeOf("A portrait of an old fisherman"), null);
});

test("FLUX.2 Pro gets the shape at under one megapixel, so the price never changes", () => {
  assert.equal(falInput(model("flux-2-pro"), "p", "a red fox").image_size, "landscape_4_3");
  for (const request of ["instagram story", "poster", "square", "banner"]) {
    const size = falInput(model("flux-2-pro"), "p", request).image_size as { width: number; height: number };
    assert.ok(size.width * size.height < 1_000_000, request);
    assert.equal(size.width % 16, 0);
    assert.equal(size.height % 16, 0);
  }
  assert.deepEqual(falInput(model("flux-2-pro"), "p", "tiktok cover").image_size, { width: 720, height: 1280 });
});

test("videos are wide unless asked otherwise, and Veo never gets square", () => {
  assert.equal(falInput(model("kling-3"), "p", "a dog running").aspect_ratio, "16:9");
  assert.equal(falInput(model("kling-3"), "p", "a vertical video of a dog for TikTok").aspect_ratio, "9:16");
  assert.equal(falInput(model("kling-3"), "p", "a square clip of a dog").aspect_ratio, "1:1");
  assert.equal(falInput(model("veo-3.1"), "p", "a square clip of a dog talking").aspect_ratio, "16:9");
  assert.equal(falInput(model("veo-3.1"), "p", "a reel of a dog talking").aspect_ratio, "9:16");
  assert.equal(videoAspect("a short film about rain, vertical"), "9:16");
});
