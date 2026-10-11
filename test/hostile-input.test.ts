import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fixesPictureText, followsForecast, pictureFollowUp, route, textToSpeak } from "../src/lib/router.ts";
import { autoLevel, needsCare } from "../src/lib/levels.ts";
import { freeFacts } from "../src/lib/free-order.ts";
import { POST_PACK_REQUEST, movieSplit, pickModel, videoSeconds, wantsSound, type Provider } from "../src/lib/models.ts";
import { asksWeather, weatherQuestion } from "../src/lib/weather-words.ts";
import { pickVoice } from "../src/lib/voices.ts";
import { videoAspect } from "../src/lib/engines/fal-input.ts";

// Every message a person sends is read by these checks before anything is charged, so a check
// whose work grows with the square of the message would let one long message hold the server. The
// routing checks read a window of the message (see message-window.ts); the ones that read the words
// to say or film (the voice, the length of a video) read all of it. Each gets 100,000-character
// messages built to make a careless pattern retry from every position: long runs of digits, spaces
// and punctuation, lists of platform names, an opening followed by a long run, and every word the
// patterns themselves look for, repeated. test/hostile-patterns.test.ts runs each pattern on its own.
const N = 100_000;
// A pattern that backtracks takes seconds here; a busy test machine takes a few milliseconds.
const LIMIT_MS = 250;

type Check = [string, (message: string) => unknown];
const providers = new Set<Provider>(["fal", "openai", "elevenlabs"]);
// After an app, route() reads the message exactly as it does otherwise and then reads it again as a
// possible change, so the routes after an app also cover the plain ones.
const afterApp: Check[] = [
  ["route after an app", (m) => route(m, undefined, "app")],
  ["spoken route after an app", (m) => route(m, undefined, "app", { spoken: true })],
  ["route with a photo", (m) => route(m, "image/png")],
];
const others: Check[] = [
  ["needsCare", (m) => needsCare(m)],
  ["autoLevel", (m) => autoLevel("text", m)],
  ["freeFacts", (m) => freeFacts({ message: m, inputChars: m.length })],
  ["post-pack check", (m) => POST_PACK_REQUEST.test(m)],
  ["pickModel", (m) => [pickModel("image", m, providers), pickModel("video", m, providers), pickModel("music", m, providers)]],
  ["asksWeather", (m) => asksWeather(m)],
  ["weatherQuestion", (m) => weatherQuestion(m)],
  ["followsForecast", (m) => followsForecast({ engine: "search", reason: "" }, m, "Will it rain tomorrow in London?")],
  ["pictureFollowUp", (m) => pictureFollowUp(m)],
  ["fixesPictureText", (m) => fixesPictureText(m)],
  ["textToSpeak", (m) => textToSpeak(m)],
  ["pickVoice", (m) => pickVoice(m)],
  ["video length and sound", (m) => [movieSplit(m), videoSeconds(m), wantsSound(m), videoAspect(m)]],
];
const all: Check[] = [
  ["route", (m) => route(m)],
  ["spoken route", (m) => route(m, undefined, "text", { spoken: true })],
  ...afterApp,
  ...others,
];

const fill = (unit: string, end = "", start = "") =>
  start + unit.repeat(Math.ceil((N - start.length - end.length) / unit.length)).slice(0, N - start.length - end.length) + end;

const time = (f: () => unknown) => {
  const begun = performance.now();
  f();
  return performance.now() - begun;
};

// One run, and two more only when the first is over the limit, so a slow moment of the test
// machine doesn't count.
function assertFast(message: string, checks = all) {
  for (const [name, check] of checks) {
    let took = time(() => check(message));
    if (took >= LIMIT_MS) took = Math.min(took, time(() => check(message)), time(() => check(message)));
    assert.ok(took < LIMIT_MS, `${name} took ${took.toFixed(0)} ms on ${JSON.stringify(message.slice(0, 30))}… (${message.length} characters)`);
  }
}

test("digit runs, punctuation runs, platform lists and openings followed by a long run are read quickly", () => {
  const runs = [
    fill("1"),
    fill("1", " oven"),
    fill("1", "x"),
    fill("1."),
    fill("1.", "5 km"),
    fill("1 "),
    fill("1,"),
    fill("12.5 "),
    fill("1°"),
    fill("1° ", "f"),
    fill(" "),
    fill(" ", "x"),
    fill(" ", "?"),
    fill("\n"),
    fill("\t", "x"),
    fill("?"),
    fill("?", "x"),
    fill("!"),
    fill("!", "x"),
    fill("."),
    fill(".", "x"),
    fill("?!. "),
    fill("? "),
    fill(". ", "x"),
    fill("“"),
    fill('"'),
    fill(":"),
    fill("ig "),
    fill("ig, "),
    fill("ig, ", "posts"),
    fill("ig and "),
    fill("Instagram, "),
    fill("instagram, tiktok and ", "x"),
    fill("fb & "),
    fill("insta + "),
    fill("posts for ig "),
    fill("Fix "),
    fill("Add "),
    fill("make "),
    fill("button "),
    fill("and "),
    fill("what about "),
    fill("is it "),
    fill("in Aa "),
    fill("Aa "),
    fill("天"),
    fill("é"),
    fill("😀 "),
    fill("```"),
    fill("http://a.b "),
    fill("prévisions "),
    fill("weather in Paris "),
    fill("is a open "),
    fill("fixtures ", "", "match "),
    fill("Aa ", "?", "天"),
    fill("Aaaa ", "?", "Is it cold in "),
    fill("? ", "x", "Weather in Aaa "),
    fill("a", "", "hurricane coming "),
    // The weather words read only the first 2,000 characters: a run of digits there, after the words
    // that check whether a temperature is about the air.
    "what's the temperature today? temperature today, how hot is it today, humidity today, " + "1".repeat(1900) + " oven" + " and more text".repeat(7000),
  ];
  // An opening a pattern reads from the start, then a long run that can be split many ways.
  const openings = [
    "how much is a dollar in naira",
    "is there a hurricane coming",
    "how much is bitcoin",
    "Who is the president of France",
    "Is the Louvre open tomorrow",
    "what time is it",
    "what's the date",
    "temperature",
    "hurricane coming",
    "and",
    "plus",
    "disney",
    "manga",
    "remove it",
    "delete it",
    "fix the text",
    "and What",
    "say",
    "Say “hi",
  ];
  for (const opening of openings) {
    for (const [unit, end] of [
      [" ", "x"],
      [" ", "!"],
      [" ", "?"],
      ["\t", "x"],
      ["?", "x"],
      [".", "x"],
      ["!", " x"],
    ]) {
      runs.push(fill(unit, end, `${opening}${unit === " " || unit === "\t" ? "" : " "}`));
    }
  }
  for (const message of runs) assertFast(message);
});

// The words and phrases inside every pattern in the files that read messages, found from the
// source itself (regular expression literals and the String.raw pieces patterns are built from), so
// a pattern added later is covered without editing this list.
function patternWords(): string[] {
  const files = ["router.ts", "weather-words.ts", "free-order.ts", "weather.ts", "context-note.ts", "levels.ts", "models.ts", "voices.ts"];
  const words = new Set<string>();
  for (const file of files) {
    const path = new URL(`../src/lib/${file}`, import.meta.url);
    const source = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const raw = (node: ts.Node): boolean => {
      let template = node;
      while (!ts.isNoSubstitutionTemplateLiteral(template) && !ts.isTemplateExpression(template)) template = template.parent;
      return ts.isTaggedTemplateExpression(template.parent) && template.parent.tag.getText(source) === "String.raw";
    };
    const visit = (node: ts.Node) => {
      if (ts.isRegularExpressionLiteral(node) || (ts.isTemplateLiteralToken(node) && raw(node))) {
        const text = node.getText(source).replace(/\\[pP]\{[^}]*\}|\\u\{?[0-9a-fA-F]+\}?|\\x[0-9a-fA-F]{2}|\\[a-zA-Z]/g, " ");
        for (const word of text.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu) ?? []) if (word.length >= 2) words.add(word.toLowerCase());
        for (const piece of text.split(/[|()[\]{}?*+^$/`]/)) {
          const phrase = piece.replace(/\\/g, "").trim();
          if (phrase.includes(" ") && phrase.length <= 40 && /^[\p{L}\p{M}' .,-]+$/u.test(phrase)) words.add(phrase.toLowerCase());
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...words];
}

test("every word the patterns look for, repeated to 100,000 characters, is read quickly", () => {
  const words = patternWords();
  assert.ok(words.length > 300, `found ${words.length} words in the patterns`);
  // Each word as written, capitalised, and in a list, so one message tries all three.
  for (const word of words) assertFast(fill(`${word} ${word[0].toUpperCase()}${word.slice(1)}, `), [...afterApp, ...others]);
});
