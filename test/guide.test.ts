import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { GUIDE_GOALS, NO_ANSWERS, ANSWER_CHARS, writeRequest } = await import("../src/lib/guide.ts");
const { translate } = await import("../src/lib/i18n.ts");
const { ENGINES } = await import("../src/lib/types.ts");

const english = Object.assign((text: string, blanks?: Record<string, string>) => translate(null, text, blanks), { locale: "en-US" });
const goal = (id: string) => GUIDE_GOALS.find((g) => g.id === id)!;

test("Help me ask writes the whole request from the answers tapped", () => {
  const request = writeRequest(
    goal("website"),
    { subject: "my restaurant", extras: ["a photo gallery", "online booking", "customer reviews"], audience: "customers", style: "elegant", note: "It's called Chez Ana, in Douala." },
    english,
  );
  assert.equal(
    request,
    "Build a website for my restaurant. Include a photo gallery, online booking, and customer reviews. It's for customers. Style: elegant. It's called Chez Ana, in Douala.",
  );
});

test("a question left out says nothing, and typed answers are kept as written, cut to size", () => {
  assert.equal(writeRequest(goal("store"), { ...NO_ANSWERS, subject: "  hand-painted pottery " }, english), "Build an online store that sells hand-painted pottery.");
  const long = writeRequest(goal("advice"), { ...NO_ANSWERS, subject: "x".repeat(500) }, english);
  assert.equal(long, `Give me advice on ${"x".repeat(ANSWER_CHARS)}.`);
  // Questions a goal doesn't ask aren't written even if an answer is left over from going back.
  assert.equal(writeRequest(goal("advice"), { ...NO_ANSWERS, subject: "marketing ideas", audience: "students", style: "elegant" }, english), "Give me advice on marketing ideas.");
});

test("answers picked from the list are written in the language Flash is shown in", () => {
  const fr: Record<string, string> = JSON.parse(readFileSync(new URL("../src/lib/i18n/fr.json", import.meta.url), "utf8"));
  const french = Object.assign((text: string, blanks?: Record<string, string>) => translate(fr, text, blanks), { locale: "fr-FR" });
  assert.equal(
    writeRequest(goal("picture"), { ...NO_ANSWERS, subject: "a poster", extras: ["bright colours", "soft light"], style: "elegant" }, french),
    "Crée une image : une affiche. Inclure : des couleurs vives et une lumière douce. Style : élégant.",
  );
});

test("every goal goes to a real tool and offers answers to tap", () => {
  for (const g of GUIDE_GOALS) {
    assert.ok(g.engine === "auto" || ENGINES.includes(g.engine), g.id);
    assert.ok(g.subjects.length >= 3 && g.extras.length >= 3, g.id);
    assert.match(g.opening, /\{subject\}/, g.id);
  }
});
