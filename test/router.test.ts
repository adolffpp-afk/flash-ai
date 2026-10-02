import { test } from "node:test";
import assert from "node:assert/strict";
import { route, textToSpeak } from "../src/lib/router.ts";

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

test("textToSpeak pulls out the words to say", () => {
  assert.equal(textToSpeak('Say "good morning everyone"'), "good morning everyone");
  assert.equal(textToSpeak("Read this aloud: Welcome to Flash AI"), "Welcome to Flash AI");
});
