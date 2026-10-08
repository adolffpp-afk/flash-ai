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

test("undoing, saying no, sharing, sound and account asks after a picture don't pay for an edit", () => {
  for (const ask of [
    "change it back",
    "make it like before",
    "undo the last edit",
    "great edit!",
    "love the crop",
    "it's perfect, don't change anything",
    "I didn't ask you to change the background",
    "it’s perfect, don’t change anything",
    "didn’t you add a hat?",
    "wait why did you add a hat",
    "a little too dark but I love it",
    "put it on whatsapp",
    "add it to my album",
    "delete the last one",
    "add some background music",
    "change your voice",
    "add 100 credits to my account",
    "change my password",
    "switch to french",
    "teach me to remove the background",
    "steps to remove the background in photoshop",
    "change of plans",
  ]) {
    assert.equal(pictureFollowUp(ask), false, ask);
  }
  for (const ask of [
    "change it back to blue",
    "put the hat back on",
    "don't touch her face, just make the sky pink",
    "make it darker but don't change her face",
    "ok but make it darker",
    "it's too dark",
    "put it on a beach",
    "add music notes around her",
    "edit the background",
  ]) {
    assert.equal(pictureFollowUp(ask), true, ask);
  }
});

test("more everyday ways to ask for a change after a picture change it, and motion makes a video", () => {
  for (const ask of [
    "the sky should be pink",
    "needs more contrast",
    "in paris",
    "at the beach",
    "christmas version",
    "red please",
    "blue dress",
    "maybe a bit darker",
    "full body",
    "close-up",
    "I want it brighter",
    "I'd like a red background",
    "no hat",
    "take the hat off",
    "would you mind adding a hat",
    "his hand looks weird, fix it",
    "you forgot the dog",
    "smiling please",
    "too much red",
    "background white",
    "claymation",
    "as a superhero",
  ]) {
    assert.equal(pictureFollowUp(ask), true, ask);
  }
  for (const ask of ["add some motion", "make it come to life", "make a gif of it", "turn it into a reel"]) {
    assert.equal(route(ask, "image/png").engine, "video", ask);
  }
  assert.equal(route("add some motion blur", "image/png").engine, "image");
  for (const ask of ["no thanks", "no change", "take the day off", "zoom meeting at 5", "show more of the code", "the email should be warmer"]) {
    assert.equal(pictureFollowUp(ask), false, ask);
  }
});

test("a very long message is checked quickly", () => {
  const long = "ok, ".repeat(25_000);
  const started = performance.now();
  pictureFollowUp(long);
  route(long, "image/png");
  assert.ok(performance.now() - started < 500, "well under a second");
});

test("questions, shared moments and everyday problems in an attached photo get words, not an edit", () => {
  for (const ask of [
    "could the rash be eczema?",
    "can the shelf hold a TV?",
    "our family together at Christmas, write a caption",
    "my baby smiling for the first time",
    "new haircut!",
    "I love this place, plan a trip here",
    "best way to get rid of this mold?",
    "move the meeting up an hour",
    "my son dressed as a pirate, so cute",
    "my cat is too fat, diet plan please",
  ]) {
    const engine = route(ask, "image/jpeg").engine;
    assert.ok(engine !== "image" && engine !== "video", `${ask} → ${engine}`);
  }
  assert.equal(route("turn me into a movie star", "image/jpeg").engine, "image", "a still picture, not a video");
  for (const ask of ["and a recipe", "a haiku instead", "make it my profile pic", "put it in my portfolio"]) {
    assert.equal(pictureFollowUp(ask), false, ask);
  }
  for (const ask of ["can the sky be pink", "can the dog hold a sign", "me and my sister together at the Eiffel Tower", "get rid of the people", "move the cat to the left", "paint the walls blue"]) {
    assert.ok(["image", "video"].includes(route(ask, "image/jpeg").engine), ask);
  }
});
