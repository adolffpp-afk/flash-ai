import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { route } from "../src/lib/router.ts";
import { needsCare } from "../src/lib/levels.ts";
import { freeFacts } from "../src/lib/free-order.ts";
import { POST_PACK_REQUEST } from "../src/lib/models.ts";
import { asksWeather, weatherQuestion } from "../src/lib/weather-words.ts";

// Every message a person types is read by these checks before anything is charged, so a pattern
// whose work grows with the square of the message would let one long message hold the server.
// Each check gets 100,000-character messages built to make a careless pattern retry from every
// position: long runs of digits and punctuation, long lists of platform names, and every word
// the patterns themselves look for, repeated.
const N = 100_000;
const LIMIT_MS = 50;

type Check = [string, (message: string) => unknown];
const others: Check[] = [
  ["needsCare", (m) => needsCare(m)],
  ["freeFacts", (m) => freeFacts({ message: m, inputChars: m.length })],
  ["post-pack check", (m) => POST_PACK_REQUEST.test(m)],
  ["asksWeather", (m) => asksWeather(m)],
  ["weatherQuestion", (m) => weatherQuestion(m)],
];
// After an app, route() reads the message exactly as it does otherwise and then reads it again as a
// possible change, so the two routes after an app also cover the plain ones.
const afterApp: Check[] = [
  ["route after an app", (m) => route(m, undefined, "app")],
  ["spoken route after an app", (m) => route(m, undefined, "app", { spoken: true })],
];
const all: Check[] = [
  ["route", (m) => route(m)],
  ["spoken route", (m) => route(m, undefined, "text", { spoken: true })],
  ...afterApp,
  ...others,
];

const fill = (unit: string, end = "") => unit.repeat(Math.ceil((N - end.length) / unit.length)).slice(0, N - end.length) + end;

const time = (f: () => unknown) => {
  const start = performance.now();
  f();
  return performance.now() - start;
};

// One run, and two more only when the first is over the limit, so a slow moment of the test
// machine doesn't count; a pattern that backtracks takes seconds here, every time.
function assertFast(message: string, checks = all) {
  for (const [name, check] of checks) {
    let took = time(() => check(message));
    if (took >= LIMIT_MS) took = Math.min(took, time(() => check(message)), time(() => check(message)));
    assert.ok(took < LIMIT_MS, `${name} took ${took.toFixed(0)} ms on ${JSON.stringify(message.slice(0, 30))}… (${message.length} characters)`);
  }
}

test("digit runs, punctuation runs and platform lists of 100,000 characters are read in under 50 ms", () => {
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
    fill("?"),
    fill("?", "x"),
    fill("!"),
    fill("!", "x"),
    fill("."),
    fill(".", "x"),
    fill("?!. "),
    fill("? "),
    fill(". ", "x"),
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
    // The weather words read only the first 2,000 characters: a run of digits there, after the words
    // that check whether a temperature is about the air.
    "what's the temperature today? temperature today, how hot is it today, humidity today, " + "1".repeat(1900) + " oven" + " and more text".repeat(7000),
  ];
  for (const message of runs) assertFast(message);
});

// The words and phrases inside every pattern in the files that read messages, found from the
// source itself (regular expression literals and the String.raw pieces patterns are built from), so
// a pattern added later is covered without editing this list.
function patternWords(): string[] {
  const files = ["router.ts", "weather-words.ts", "free-order.ts", "weather.ts", "context-note.ts", "levels.ts", "models.ts"];
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

test("every word the patterns look for, repeated to 100,000 characters, is read in under 50 ms", () => {
  const words = patternWords();
  assert.ok(words.length > 300, `found ${words.length} words in the patterns`);
  // Each word as written, capitalised, and in a list, so one message tries all three.
  for (const word of words) assertFast(fill(`${word} ${word[0].toUpperCase()}${word.slice(1)}, `), [...afterApp, ...others]);
});
