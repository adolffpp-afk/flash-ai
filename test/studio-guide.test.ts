import { test } from "node:test";
import assert from "node:assert/strict";

const { STUDIO_ANSWER_CHARS, STUDIO_IDEAS, STUDIO_QUESTIONS, writeBrief } = await import("../src/lib/studio-guide.ts");
const { helperSystem } = await import("../src/lib/prompt-helper.ts");
const { translate } = await import("../src/lib/i18n.ts");

const english = (text: string, blanks?: Record<string, string>) => translate(null, text, blanks);

test("the Studio's questions write a story brief with what a story needs", () => {
  assert.equal(
    writeBrief("story", { kind: "a love story", place: "Douala", cast: "a young nurse and the doctor who left her", mood: "emotional", ending: "a big twist" }, english),
    "Kind of story: a love story. Where it happens: Douala. Main characters: a young nurse and the doctor who left her. Feeling: emotional. This part ends with: a big twist.",
  );
});

test("an ad brief says only what was answered, and typed answers are cut to size", () => {
  assert.equal(writeBrief("ad", { product: "my shop", action: "visit us" }, english), "An ad for: my shop. At the end, ask viewers to: visit us.");
  assert.equal(writeBrief("ad", { product: "x".repeat(400) }, english), `An ad for: ${"x".repeat(STUDIO_ANSWER_CHARS)}.`);
  assert.equal(writeBrief("story", {}, english), "");
});

test("each mode asks five questions with answers to tap, and offers ready ideas", () => {
  for (const kind of ["story", "ad"] as const) {
    assert.equal(STUDIO_QUESTIONS[kind].length, 5);
    for (const q of STUDIO_QUESTIONS[kind]) assert.ok(q.answers.length >= 4, q.key);
    assert.ok(STUDIO_IDEAS[kind].length >= 3);
  }
});

test("Prompt Helper writes Studio briefs for a story or an ad, never the script", () => {
  assert.match(helperSystem("story"), /drama in parts/);
  assert.match(helperSystem("story"), /Don't write the script/);
  assert.match(helperSystem("ad"), /video ad maker/);
});
