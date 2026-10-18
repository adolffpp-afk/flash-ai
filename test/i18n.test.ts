import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const { afterSentence, english, fill, localeOf, translate, uiLanguage } = await import("../src/lib/i18n.ts");
const { LANGUAGES } = await import("../src/lib/languages.ts");
const { findPhrases } = await import("../scripts/i18n-keys.ts");
const { findFeatures } = await import("../src/lib/features.ts");

const root = new URL("..", import.meta.url).pathname;
const tableOf = (id: string): Record<string, string> => JSON.parse(readFileSync(`${root}src/lib/i18n/${id}.json`, "utf8"));
const blanksIn = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const found = findPhrases(root);
const phrases = [...found.phrases.keys()];

test("a phrase comes from the table, else in English, with its blanks filled", () => {
  assert.equal(fill("{count} credits left", { count: 12 }), "12 credits left");
  assert.equal(fill("Hi {name}, {name}", { name: "Ana" }), "Hi Ana, Ana");
  assert.equal(fill("Hi {name}", {}), "Hi {name}", "a blank with no value stays");
  assert.equal(translate({ Close: "Fermer" }, "Close"), "Fermer");
  assert.equal(translate({ Close: "" }, "Close"), "Close", "an empty translation shows the English");
  assert.equal(translate(null, "{n} left", { n: 3 }), "3 left");
  assert.equal(translate({ "{n} left": "il en reste {n}" }, "{n} left", { n: 3 }), "il en reste 3");
  assert.equal(english("Close"), "Close");
});

test("a sentence is followed by a space, except after a full-width stop", () => {
  assert.equal(afterSentence("Counting starts again at 5:00 PM."), " ");
  assert.equal(afterSentence("لوگوں کی گنتی دوبارہ شروع ہوگی۔"), " ", "Urdu's stop is followed by a space");
  assert.equal(afterSentence("人数の集計は明日の20:00に再開します。"), "");
  assert.equal(afterSentence("人数统计将于明天 20:00 重新开始。"), "");
  assert.equal(afterSentence("本当ですか？"), "");
});

test("a text that isn't one of Flash's phrases is shown as it is, even one named like an object's own fields", async () => {
  const { GITHUB_TOOL_WORDS, GOOGLE_TOOL_WORDS, toolWords } = await import("../src/lib/connectors.ts");
  const fr = tableOf("fr");
  for (const text of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) {
    assert.equal(translate(fr, text), text, text);
    assert.equal(translate(fr, text, { n: 1 }), text, text);
  }
  // Any server's tool titles and descriptions are its own words: only Flash's own (GitHub's and Google Drive's tools) are translated.
  const t = (text: string) => translate(fr, text);
  assert.equal(toolWords(t, "__proto__"), "__proto__");
  assert.equal(toolWords(t, "Close"), "Close", "a server's title that happens to be one of Flash's phrases stays as the server wrote it");
  assert.equal(toolWords(t, GITHUB_TOOL_WORDS.read_file.title), fr[GITHUB_TOOL_WORDS.read_file.title]);
  assert.notEqual(fr[GITHUB_TOOL_WORDS.read_file.title], GITHUB_TOOL_WORDS.read_file.title);
  for (const words of [...Object.values(GITHUB_TOOL_WORDS), ...Object.values(GOOGLE_TOOL_WORDS)]) {
    for (const text of [words.title, words.description]) {
      assert.ok(fr[text], text);
      assert.equal(toolWords(t, text), fr[text], text);
    }
  }
});

test("Flash shows the language picked in Settings, else the browser's when Flash has it, else English", () => {
  assert.equal(uiLanguage("fr", ["es-ES"]), "fr");
  assert.equal(uiLanguage("", ["es-MX", "fr"]), "es");
  assert.equal(uiLanguage("", ["fr-CA"]), "fr");
  assert.equal(uiLanguage("", ["zh-TW"]), "zh-Hant");
  assert.equal(uiLanguage("", ["zh-HK"]), "zh-Hant");
  assert.equal(uiLanguage("", ["zh-CN"]), "zh-Hans");
  assert.equal(uiLanguage("", ["zh"]), "zh-Hans");
  assert.equal(uiLanguage("", ["fil-PH"]), "tl");
  assert.equal(uiLanguage("", ["xx-YY", "de-AT"]), "de");
  assert.equal(uiLanguage("", ["xx"]), "en");
  assert.equal(uiLanguage(undefined, []), "en");
  assert.equal(uiLanguage("French", ["it"]), "it", "a value not on the list counts as Automatic");
  assert.equal(localeOf("fr"), "fr-FR");
  assert.equal(localeOf("ht"), "fr-HT", "browsers have no Haitian Creole dates");
  assert.match(new Date(2026, 9, 10).toLocaleDateString(localeOf("ar"), { month: "long" }), /أكتوبر/, "Arabic dates are Gregorian");
  assert.equal(localeOf("en"), "en-US");
});

test("every language Flash offers has a table, and English is the source", () => {
  for (const { id } of LANGUAGES) {
    if (id === "en") assert.ok(!existsSync(`${root}src/lib/i18n/en.json`));
    else assert.ok(existsSync(`${root}src/lib/i18n/${id}.json`), id);
  }
  const loaders = readFileSync(`${root}src/lib/i18n-tables.ts`, "utf8");
  for (const { id } of LANGUAGES.filter((l) => l.id !== "en")) assert.ok(loaders.includes(`import("./i18n/${id}.json")`), `${id} loads`);
});

test("phrases use {blanks}, never ${…}, so they can be translated", () => {
  assert.deepEqual(found.joined, []);
  assert.ok(phrases.length > 100);
});

test("each table has only phrases Flash shows, with the same blanks", () => {
  for (const { id } of LANGUAGES.filter((l) => l.id !== "en")) {
    const table = tableOf(id);
    for (const [english, translated] of Object.entries(table)) {
      assert.ok(found.phrases.has(english), `${id}: "${english}" isn't shown anywhere`);
      assert.equal(typeof translated, "string", `${id}: "${english}"`);
      assert.deepEqual(blanksIn(translated), blanksIn(english), `${id}: "${english}" keeps its blanks`);
    }
  }
});

test("every table translates every phrase Flash shows", () => {
  for (const { id } of LANGUAGES.filter((l) => l.id !== "en")) {
    const table = tableOf(id);
    const missing = phrases.filter((p) => !table[p]?.trim());
    assert.deepEqual(missing.slice(0, 5), [], `${id}: ${missing.length} phrases still in English`);
  }
});

test("the search finds a feature by its name in the language Flash is shown in", () => {
  const t = (text: string) => translate({ "Remove Background": "Supprimer l'arrière-plan" }, text);
  assert.deepEqual(findFeatures("arrière", undefined, t).map((f) => f.title), ["Remove Background"]);
  assert.deepEqual(findFeatures("background", undefined, t).map((f) => f.title), ["Remove Background"], "English still works");
});

test("the server answers in the account's language, else the browser's, else English", async () => {
  const { acceptLanguages, translatorFor } = await import("../src/lib/server/i18n.ts");
  assert.deepEqual(acceptLanguages("fr-CA,fr;q=0.9,en;q=0.8"), ["fr-CA", "fr", "en"]);
  assert.deepEqual(acceptLanguages("en;q=0.5, de"), ["de", "en"]);
  assert.deepEqual(acceptLanguages("*, es;q=0"), []);
  assert.deepEqual(acceptLanguages(null), []);
  const plain = await translatorFor(new Request("http://flash.test/"));
  assert.equal(plain.language, "en");
  assert.equal(plain("{count} left", { count: 2 }), "2 left");
});
