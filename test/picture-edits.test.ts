import { test } from "node:test";
import assert from "node:assert/strict";
import { fixesPictureText, pictureFollowUp, route } from "../src/lib/router.ts";

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

test("praise, questions and other jobs right after a picture never pay for an edit", () => {
  for (const ask of [
    "omg i love the background",
    "love the style",
    "so cinematic",
    "he looks older",
    "how did you make this?",
    "did you add a hat",
    "can I use it as my profile picture?",
    "would it look good as a background on my laptop",
    "turn it into a song",
    "turn this into a story",
    "make a story from it",
    "give the cat a name",
    "you should be proud",
    "more",
    "more please",
    "more like that",
    "more or less",
    "make me another",
    "same style but a horse",
    "delete it",
    "convert it to pdf",
    "add hashtags",
    "make my day",
    "it should be fine",
    "typo in my last message",
    "good night",
    "red or blue?",
    "a poem instead",
  ]) {
    assert.equal(pictureFollowUp(ask), false, ask);
  }
});

test("everyday ways to ask for a change right after a picture change it", () => {
  for (const ask of [
    "darker",
    "watercolor please",
    "pixar style",
    "in the style of van gogh",
    "at night",
    "same but in winter",
    "ok now bigger",
    "great, now in red",
    "with a hat",
    "and a dog",
    "a cat instead",
    "16:9",
    "can the sky be pink",
    "I'd like the dog to be bigger",
    "how about at sunset",
    "it's too dark",
    "draw a mustache on him",
    "paint the walls blue",
    "rotate it",
    "move the cat to the left",
    "fix the hands",
    "have him hold a sign",
    "give it a vintage feel",
    "add another one",
    "give her a new dress, a pink one",
    "keep the same style but make it darker",
    "make it more like that",
    "do it red",
    "chage the background",
    "it should say Happy Birthday",
    "fix the spelling",
    "would it be possible to make it darker",
  ]) {
    assert.equal(pictureFollowUp(ask), true, ask);
  }
  // A gif or a short film moves; a movie poster is a picture.
  assert.equal(route("make it a gif", "image/png").engine, "video");
  assert.equal(route("turn it into a short film", "image/png").engine, "video");
  assert.equal(route("turn this into a movie poster", "image/png").engine, "image");
  // Fixing the words is only about Flash's own picture: an attached essay's text gets words.
  assert.equal(fixesPictureText("fix the spelling"), true);
  assert.equal(route("fix the text", "image/png").engine, "text");
});

test("with a photo attached, questions, sums, advice and writing jobs still get words", () => {
  for (const ask of [
    "make flashcards from this",
    "create a recipe from this",
    "give her a nice reply",
    "give the dog a name",
    "should I wear this to the interview",
    "dressed as a witch, what do you think",
    "suggest a hairstyle for my face shape",
    "make my essay better",
    "add these up",
    "more details",
    "without tax what is the total?",
    "how do I change the background on my phone",
    "do people wear hats there?",
    "do a style analysis of this painting",
    "can the image be used commercially",
    "too big to email",
  ]) {
    assert.equal(route(ask, "image/jpeg").engine, "text", ask);
  }
  for (const ask of ["turn me into a game character", "add a thumbs up", "change the background to whatever you suggest", "give him a name tag that says Bob"]) {
    assert.equal(route(ask, "image/jpeg").engine, "image", ask);
  }
});
