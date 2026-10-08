import { test } from "node:test";
import assert from "node:assert/strict";
import { pictureFollowUp, route } from "../src/lib/router.ts";

test("an attached photo is changed when asked in everyday words", () => {
  for (const ask of [
    "give him sunglasses",
    "fix the lighting",
    "he should be wearing a suit",
    "let me wear a red dress",
    "can you make me look older",
    "make my skin smoother",
    "brighten it up a little",
    "crop it to a square",
    "zoom out a bit",
    "make a poster from this",
    "turn that into a watercolour",
    "more red",
    "a bit less busy",
    "without the people in the back",
    "photoshop the bin out",
  ]) {
    assert.equal(route(ask, "image/jpeg").engine, "image", ask);
  }
});

test("questions and other jobs with a photo attached still get words", () => {
  for (const [ask, engine] of [
    ["What is in this picture?", "text"],
    ["Is he wearing a ring?", "text"],
    ["describe the style of this", "text"],
    ["add up the numbers on this receipt", "text"],
    ["less than what?", "text"],
    ["write a caption for it", "text"],
    ["Copy all the text", "docs"],
    ["Translate the text in this photo to English", "translate"],
    ["turn this screenshot into a website", "app"],
  ] as const) {
    assert.equal(route(ask, "image/jpeg").engine, engine, ask);
  }
});

test("a follow-up right after a picture changes that picture", () => {
  for (const ask of [
    "make it darker",
    "add a hat to the cat",
    "now put him on a beach",
    "give him sunglasses",
    "more red",
    "less busy please",
    "without the text",
    "change the background to a beach",
    "perfect, now make it more realistic",
    "replace the cat with a dog",
    "make it black and white",
    "put my logo in the corner",
    "turn it into a poster",
    "make a poster from it",
  ]) {
    assert.equal(pictureFollowUp(ask), true, ask);
  }
  // Bringing it to life is a follow-up too: the picture goes with it and becomes a video.
  assert.equal(pictureFollowUp("bring it to life"), true);
  assert.equal(route("make it a video", "image/png").engine, "video");
});

test("anything else after a picture is answered on its own", () => {
  for (const ask of [
    "thanks!",
    "nice",
    "what is this?",
    "who is that",
    "make another one",
    "try again",
    "make a new picture of a cat",
    "draw me a dragon",
    "make me a logo for my bakery",
    "create an image of a red car",
    "generate 3 more",
    "write a caption for it",
    "make it into a song",
    "turn it into a website",
    "translate it to French",
    "build me a todo app",
    "make a presentation about dogs",
    "give me a caption",
    "what's the weather today",
    "hello",
    "",
  ]) {
    assert.equal(pictureFollowUp(ask), false, ask);
  }
});
