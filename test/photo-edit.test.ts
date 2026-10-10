import { test } from "node:test";
import assert from "node:assert/strict";
import { imageDimensions } from "../src/lib/imageSize.ts";
import { route } from "../src/lib/router.ts";
import { MODELS, pickModel, modelCredits } from "../src/lib/models.ts";
import { falEditInput } from "../src/lib/engines/fal-input.ts";

const png = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number) =>
  // SOI, an APP0 segment, then SOF0 with height and width.
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0]);

test("photo sizes are read from PNG and JPEG headers", () => {
  assert.deepEqual(imageDimensions(png(1200, 800)), { width: 1200, height: 800 });
  assert.deepEqual(imageDimensions(jpeg(1920, 1080)), { width: 1920, height: 1080 });
  assert.equal(imageDimensions(new Uint8Array([1, 2, 3])), null);
});

test("a photo with a change request goes to photo editing; a question about it doesn't", () => {
  assert.equal(route("Remove the background", "image/jpeg").engine, "image");
  assert.equal(route("can you make me look like a Pixar character?", "image/png").engine, "image");
  assert.equal(route("turn this into a pencil sketch", "image/webp").engine, "image");
  assert.equal(route("What is in this picture?", "image/jpeg").engine, "text");
  assert.equal(route("describe the style of this", "image/jpeg").engine, "text");
  assert.equal(route("remove the background", "application/pdf").engine, "text");
});

test("editing uses only the editing model, and making new images never does", () => {
  const fal = new Set(["fal"] as const);
  assert.equal(pickModel("image", "make it a cartoon", fal, undefined, true)?.model.id, "flux-2-edit");
  assert.notEqual(pickModel("image", "a cat", fal)?.model.id, "flux-2-edit");
  assert.notEqual(pickModel("image", "a cat", fal, "flux-2-edit")?.model.id, "flux-2-edit");
  // At most 2048 × 2048 in and out at $0.008 a megapixel, with the markup: never at a loss.
  const edit = MODELS.find((m) => m.id === "flux-2-edit")!;
  assert.ok(modelCredits(edit) >= Math.ceil(((2 * 2048 * 2048) / 1e6) * 0.8 * 2.5));
});

test("background removal and upscaling get their own cheaper models; other edits don't", () => {
  const fal = new Set(["fal"] as const);
  const pick = (t: string) => pickModel("image", t, fal, undefined, true)?.model.id;
  assert.equal(pick("Remove the background"), "remove-bg");
  assert.equal(pick("make the background transparent"), "remove-bg");
  assert.equal(pick("cut out the person"), "remove-bg");
  assert.equal(pick("replace the background with a beach"), "flux-2-edit");
  assert.equal(pick("Upscale this photo and make it sharper"), "upscale");
  assert.equal(pick("make it HD"), "upscale");
  assert.equal(pick("enhance the colours"), "flux-2-edit");
  assert.equal(pick("make it a cartoon"), "flux-2-edit");
  // Making new images never uses them.
  assert.notEqual(pickModel("image", "a transparent glass, upscale look", fal)?.model.id, "upscale");
  assert.equal(route("Upscale this photo and make it sharper", "image/jpeg").engine, "image");
});

test("photo tools never run at a loss", () => {
  const credits = (id: string) => modelCredits(MODELS.find((m) => m.id === id)!);
  assert.ok(credits("remove-bg") >= Math.ceil(1.8 * 2.5), "Bria is $0.018 a photo");
  // The longest output side is 4,096 px, so at most 16.8 MP at $0.001 each.
  assert.ok(credits("upscale") >= Math.ceil(((4096 * 4096) / 1e6) * 0.1 * 2.5));
  const up = MODELS.find((m) => m.id === "upscale")!;
  for (const [w, h] of [[2048, 2048], [512, 300], [4000, 1000], [100, 100]]) {
    const { upscale_factor: f } = falEditInput(up, "x", { width: w, height: h }, "") as { upscale_factor: number };
    assert.ok(Math.max(w, h) * f <= 4096 && f >= 1 && f <= 4, `${w}×${h} → ${f}`);
  }
});

test("asking to animate an attached photo makes a video from it", () => {
  const fal = new Set(["fal"] as const);
  assert.equal(route("Animate this photo with natural, gentle motion", "image/jpeg").engine, "video");
  assert.equal(route("bring it to life", "image/png").engine, "video");
  assert.equal(route("make her smile and wave", "image/png").engine, "video");
  assert.equal(route("remove the background", "image/png").engine, "image");
  assert.equal(pickModel("video", "animate this", fal, undefined, true)?.model.id, "kling-3-animate");
  assert.notEqual(pickModel("video", "a cat runs", fal)?.model.id, "kling-3-animate", "never for new videos");
  const animate = MODELS.find((m) => m.id === "kling-3-animate")!;
  assert.equal(modelCredits(animate, "animate this"), 141, "5 s silent at $0.112/s and the picture check, with the markup");
  assert.equal(modelCredits(animate, "animate this with ocean sound, 10 seconds"), 421);
  assert.equal(modelCredits(animate, "animate this, no sound"), 141);
});
