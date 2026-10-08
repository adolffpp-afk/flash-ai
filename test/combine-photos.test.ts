import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_EDIT_PHOTOS, modelById, modelCredits, requestCents } from "../src/lib/models.ts";
import { falEditInput } from "../src/lib/engines/fal-input.ts";
import { route } from "../src/lib/router.ts";

const edit = modelById("flux-2-edit")!;

test("each extra photo in one edit costs more, so combining never runs at a loss", () => {
  assert.equal(modelCredits(edit, "make it darker"), 18, "one photo costs what it always did");
  assert.equal(modelCredits(edit, "", 1), 18);
  assert.equal(modelCredits(edit, "", 2), 27);
  assert.equal(modelCredits(edit, "", 4), 44);
  assert.equal(modelCredits(edit, "", 9), 44, "the model reads at most four");
  // At $0.008 a megapixel in and out, four photos of 2048 × 2048 and the result cost about 16.8 cents.
  const worst = ((MAX_EDIT_PHOTOS + 1) * 2048 * 2048 * 0.8) / 1e6;
  assert.ok(requestCents(edit, "", MAX_EDIT_PHOTOS) >= worst, `${requestCents(edit, "", MAX_EDIT_PHOTOS)} covers ${worst.toFixed(2)}`);
  // Other photo tools take one photo, and their price doesn't change.
  const removeBg = modelById("remove-bg")!;
  assert.equal(modelCredits(removeBg, "", 3), modelCredits(removeBg));
});

test("the photos after the first go to the model too, at most four in all", () => {
  const one = falEditInput(edit, "data:a", { width: 1024, height: 768 }, "make it darker");
  assert.deepEqual(one.image_urls, ["data:a"]);
  const many = falEditInput(edit, "data:a", { width: 1024, height: 768 }, "put us on a beach", ["data:b", "data:c", "data:d", "data:e"]);
  assert.deepEqual(many.image_urls, ["data:a", "data:b", "data:c", "data:d"]);
  assert.deepEqual(many.image_size, { width: 1024, height: 768 }, "the result takes the first photo's shape");
});

test("asking to combine photos is a photo edit", () => {
  for (const ask of [
    "combine these two photos",
    "put me and my dog on a beach",
    "me and my sister together at the Eiffel Tower",
    "merge them into one picture",
    "blend the two",
    "put the logo on the t-shirt",
    "show us in the same photo",
  ]) {
    assert.equal(route(ask, "image/jpeg").engine, "image", ask);
  }
  assert.equal(route("which of these photos is better?", "image/jpeg").engine, "text");
  assert.equal(route("are they together?", "image/jpeg").engine, "text");
});
