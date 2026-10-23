import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RECURRING_CHARS, SCHEDULE_LANGUAGES, SCHEDULE_PATTERNS, asksRecurring, fold, needs, quickCheck } from "../src/lib/schedule-words.ts";

/*
 * For each of Flash's 30 languages: asks for something done again and again, or later, and one-off
 * messages that only look like one (a schedule word, a request word, a reminder or "automatic" word,
 * a date, or a word with one of the tables' words inside it). hostile-patterns.test.ts reads them too.
 */
const SAMPLES: Record<string, { asks: string[]; not: string[] }> = JSON.parse(readFileSync(new URL("./fixtures/schedule-words.json", import.meta.url), "utf8"));

test("every language has its asks and its one-off messages", () => {
  assert.equal(SCHEDULE_LANGUAGES.length, 30);
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...SCHEDULE_LANGUAGES].sort());
  for (const [lang, { asks, not }] of Object.entries(SAMPLES)) assert.ok(asks.length >= 10 && not.length >= 15, lang);
});

test("asks for something done again and again or later are seen, in each language", () => {
  const missed = Object.entries(SAMPLES).flatMap(([lang, { asks }]) => asks.filter((s) => !asksRecurring(s)).map((s) => `${lang}: ${s}`));
  assert.deepEqual(missed, []);
});

test("one-off messages that only look like one aren't, in each language", () => {
  const seen = Object.entries(SAMPLES).flatMap(([lang, { not }]) => not.filter((s) => asksRecurring(s)).map((s) => `${lang}: ${s}`));
  assert.deepEqual(seen, []);
});

test("a schedule counts with a request in its own sentence or part, close by", () => {
  // The headline ask, with and without its comma, with the schedule on a line of its own, and after.
  for (const ask of [
    "Every Monday at 8, give me the 5 most important electric car news points",
    "Every Monday at 8 give me the 5 most important electric car news points",
    "Every Monday at 8:\nsend me the news about electric cars",
    "Send me the news about electric cars, every Monday at 8",
  ]) {
    assert.ok(asksRecurring(ask), ask);
  }
  // A schedule in another part of the sentence, in another sentence, or far from the request.
  for (const ask of [
    "I go to the gym every Monday, give me a workout plan",
    "We meet every Monday. Write me an agenda for the next meeting",
    "Tell me about the history of the old town and its churches and the little market that opens every Saturday",
  ]) {
    assert.equal(asksRecurring(ask), false, ask);
  }
});

test("quoted text and code don't count", () => {
  assert.equal(asksRecurring('Translate "every Monday, send me the news" into German'), false);
  assert.equal(asksRecurring("Fix this:\n```\n// every day, send me the report\nrun(report)\n```"), false);
  assert.equal(asksRecurring("Rename `every day send me` to something shorter"), false);
  // A quote mark inside a Hebrew abbreviation isn't a quote: "send me a report every morning on the roads in Tel Aviv".
  assert.ok(asksRecurring('שלח לי דו"ח כל בוקר על מצב הכבישים בת"א'));
});

test("only the start of a message is read, and an empty one isn't an ask", () => {
  assert.ok(asksRecurring(`${"x".repeat(RECURRING_CHARS - 40)}. Remind me to call the bank`));
  assert.equal(asksRecurring(`${"x".repeat(RECURRING_CHARS)}. Remind me to call the bank`), false);
  assert.equal(asksRecurring(""), false);
  assert.equal(asksRecurring("   "), false);
});

/*
 * The quick check before each pattern is built (see needs in schedule-words.ts): it must never miss a
 * text the pattern matches, or a message that asks wouldn't be seen.
 */
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

test("text is folded the way /iu compares letters", () => {
  // Every character with another case, and each one /iu counts as the same as it: folded alike.
  const cased: string[] = [];
  const uncased: string[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = String.fromCodePoint(c);
    (s.toLowerCase() !== s || s.toUpperCase() !== s ? cased : uncased).push(s);
  }
  const all = cased.join("");
  const unlike: string[] = [];
  for (const x of cased) for (const y of all.match(new RegExp(escape(x), "giu")) ?? []) if (fold(y) !== fold(x)) unlike.push(`${x} ${y}`);
  assert.deepEqual(unlike, []);
  // And none without another case is the same as one with.
  assert.equal(uncased.join("").match(new RegExp(`[${cased.map(escape).join("")}]`, "giu")), null);
});

test("what a pattern needs is read from it as written", () => {
  assert.deepEqual(needs("(?<![\\p{L}])(?:every|each) (?:day|week)(?![\\p{L}])")?.sort(), ["each day", "each week", "every day", "every week"]);
  // An optional piece asks for nothing; what's around it still counts.
  assert.deepEqual(needs("remind(?:er)? me"), ["remind me", "reminder me"]);
  assert.deepEqual(needs("a?\\s{1,3}tomorrow"), ["tomorrow"]);
  // "Not followed by" asks for nothing, "followed by" for what it reads.
  assert.deepEqual(needs("(?!never)\\p{L}{2,9}(?=\\s(?:now|today))"), ["now", "today"]);
  // A class of a few letters is each of them, a bigger one any letter.
  assert.deepEqual(needs("env[ií]a"), ["envia", "envía"]);
  assert.deepEqual(needs("[a-z]{2,4}"), null);
  // Every alternative has to need something.
  assert.deepEqual(needs("alpha|\\d{2}"), null);
  assert.deepEqual(needs("(?<x>\\p{L})o\\k<x>|beta")?.sort(), ["beta", "o"]);
  assert.deepEqual(needs("\\u{1F600}\\x41\\u0042"), ["\u{1F600}AB"]);
});

test("each pattern's check passes whatever the pattern matches", () => {
  const texts = Object.values(SAMPLES).flatMap(({ asks, not }) => [...asks, ...not]);
  const pieces = [...new Set(texts.flatMap((t) => [t, t.toUpperCase(), ...t.split(/[.!?;:,，、،。！？\n]/)]))];
  const missed: string[] = [];
  let matched = 0;
  for (const { source, flags } of SCHEDULE_PATTERNS) {
    assert.notEqual(needs(source), undefined, source);
    const check = quickCheck(source);
    // Plain strings, so it's quick on any text.
    if (check) assert.match(check.source, /^(?:[^\\^$.*+?()[\]{}|]|\\.)+(?:\|(?:[^\\^$.*+?()[\]{}|]|\\.)+)*$/, source.slice(0, 80));
    const pattern = new RegExp(source, flags);
    for (const piece of pieces) {
      if (!pattern.test(piece)) continue;
      matched++;
      if (check && !check.test(fold(piece))) missed.push(`${source.slice(0, 60)}: ${piece}`);
    }
  }
  assert.ok(matched > 40_000, `${matched} matches`);
  assert.deepEqual(missed, []);
  // Most patterns need something, so most messages build few of them.
  assert.ok(SCHEDULE_PATTERNS.filter(({ source }) => quickCheck(source)).length >= 140);
});
