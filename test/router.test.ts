import { test } from "node:test";
import assert from "node:assert/strict";
import { checksSpoken, route, takesGuess, textToSpeak } from "../src/lib/router.ts";

const cases: [string, string][] = [
  ["Write a short poem about the ocean", "text"],
  ["Explain how compound interest works", "text"],
  ["Give me 5 names for a bakery", "text"],
  ["Draw a cat astronaut in watercolor", "image"],
  ["Create a logo for my bakery called Sunrise", "image"],
  ["Generate an image of a red sports car", "image"],
  ["Make a video of waves crashing on a beach at sunset", "video"],
  ["Create a 8 second animation of a bouncing ball", "video"],
  ["Compose a happy jingle for my bakery", "music"],
  ["Make a lofi beat to study to", "music"],
  ["Write a song about summer love", "music"],
  ["What is the latest news about the Mars mission?", "search"],
  ["Who won the Champions League final in 2026?", "search"],
  ["Summarize https://example.com/article", "search"],
  ["Search for the best laptops for students with sources", "search"],
  ["Read this aloud: Welcome to Flash AI", "voice"],
  ["Turn this paragraph into audio: Hello there", "voice"],
  ['Say "good morning everyone"', "voice"],
  ["Write a Python function that checks if a number is prime", "code"],
  ["Why does my React component render twice?", "code"],
  ["Fix this bug: TypeError undefined is not a function", "code"],
  ["Translate 'good morning' to Spanish", "translate"],
  ["How do you say thank you in Japanese?", "translate"],
  ["Create a monthly budget spreadsheet for a family of four", "docs"],
  ["Write a cover letter for a barista job", "docs"],
  ["Make a table comparing iPhone and Pixel", "docs"],
  ["Transcribe this interview", "transcribe"],
  ["Build a todo app with categories and due dates", "app"],
  ["Make a landing page for my bakery", "app"],
  ["Create a website like Airbnb for renting cars", "app"],
  ["Make a snake game", "app"],
  ["Build a video game where you dodge asteroids", "app"],
  ["Create a dashboard to track my sales", "app"],
  ["Create a budget tracker spreadsheet", "docs"],
  ["Make a presentation about climate change", "slides"],
  ["Create a pitch deck for my startup", "slides"],
  ["Design a logo for my app", "image"],
];

for (const [msg, engine] of cases) {
  test(`routes "${msg}" to ${engine}`, () => {
    assert.equal(route(msg).engine, engine);
  });
}

test("audio attachments are transcribed", () => {
  assert.equal(route("", "audio/mpeg").engine, "transcribe");
});

test("a PDF goes to a text engine even if the message mentions a picture", () => {
  assert.equal(route("Draw conclusions from this", "application/pdf").engine, "text");
});

test("a CSV goes to docs and sheets", () => {
  assert.equal(route("What stands out here?", "text/csv").engine, "docs");
});

test("a general follow-up after an app edits the app", () => {
  assert.equal(route("Make the header blue and add a dark mode", undefined, "app").engine, "app");
  assert.equal(route("Add a slide about costs", undefined, "slides").engine, "slides");
});

test("a clear new request after an app goes to its own engine", () => {
  assert.equal(route("Draw a logo for it", undefined, "app").engine, "image");
  assert.equal(route("What's the latest news on AI?", undefined, "app").engine, "search");
});

test("textToSpeak pulls out the words to say", () => {
  assert.equal(textToSpeak('Say "good morning everyone"'), "good morning everyone");
  assert.equal(textToSpeak("Read this aloud: Welcome to Flash AI"), "Welcome to Flash AI");
});

test("in a voice conversation, talk about how Flash speaks is answered, and audio asked for is still made", () => {
  for (const m of ["Say that again", "Speak slower", "Can you read that out loud", "Narrate what you see"]) {
    assert.equal(route(m).engine, "voice", `typed: ${m}`);
    const spoken = route(m, undefined, undefined, { spoken: true });
    assert.deepEqual([spoken.engine, spoken.reason, spoken.guessed], ["text", "Flash answers in the conversation.", undefined], m);
  }
  for (const m of [
    "Read this aloud as an mp3",
    "Read this aloud: Welcome to Flash AI",
    'Say "good morning everyone"',
    "Turn this poem into audio",
    "Convert my notes into speech",
    "Read this in a British accent",
    "Say happy birthday in a deep voice",
  ]) {
    assert.equal(route(m, undefined, undefined, { spoken: true }).engine, "voice", m);
  }
});

test("after an app, a spoken follow-up edits it only when it asks for a change; typed ones as before", () => {
  for (const m of ["Thank you.", "How does it work?", "show me how it works", "let me think", "What's the function of the liver?"]) {
    assert.equal(route(m, undefined, "app").engine, "app", `typed: ${m}`);
    assert.notEqual(route(m, undefined, "app", { spoken: true }).engine, "app", m);
  }
  for (const m of ["Make the button blue", "Can you add a contact page", "Let's add a footer", "change the title to Bakery"]) {
    assert.equal(route(m, undefined, "app", { spoken: true }).engine, "app", m);
  }
  assert.equal(route("Now add a slide about costs", undefined, "slides", { spoken: true }).engine, "slides");
});

test("the router's guess: typed requests as before; spoken ones aren't made into builds, prices or voice-overs by it", () => {
  // Typed: a guess moves a request off text to anything but transcribing.
  for (const g of ["image", "video", "app", "voice", "search", "code"] as const) assert.ok(takesGuess(g, "text", "Speak slower"), g);
  assert.ok(!takesGuess("text", "text", "Hello") && !takesGuess("transcribe", "text", "Hello"));
  // Spoken: "speak slower" isn't a voice-over, an mp3 is.
  assert.ok(!takesGuess("voice", "text", "Speak slower", { spoken: true }));
  assert.ok(takesGuess("voice", "text", "Make it an mp3", { spoken: true }));
  // Spoken code, docs and search are checked again, and only move between the engines that answer in words.
  assert.ok(checksSpoken("code") && checksSpoken("docs") && checksSpoken("search"));
  assert.ok(!checksSpoken("text") && !checksSpoken("image") && !checksSpoken("app"));
  const recheck = { spoken: true, recheck: true };
  for (const g of ["text", "translate", "docs", "search"] as const) assert.ok(takesGuess(g, "code", "What's the function of the liver?", recheck), g);
  for (const g of ["code", "app", "slides", "image", "video", "music", "voice", "transcribe"] as const) {
    assert.ok(!takesGuess(g, "code", "What's the function of the liver?", recheck), g);
  }
});
