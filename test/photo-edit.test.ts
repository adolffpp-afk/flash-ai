import { test } from "node:test";
import assert from "node:assert/strict";
import { imageDimensions } from "../src/lib/imageSize.ts";
import { route } from "../src/lib/router.ts";
import { MODELS, pickModel, modelCredits } from "../src/lib/models.ts";

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
