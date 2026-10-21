/*
 * The menu's Coming soon: every planned project is shown with what it will do and a Coming soon
 * badge, nothing on it is a feature Flash already offers, and its words make no claim Flash can't
 * keep (no names that suggest technology Flash doesn't use, no promise of compliance).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMING_SOON } from "../src/lib/coming-soon.ts";
import { FEATURES } from "../src/lib/features.ts";

register("./support/tsx-hooks.mjs", import.meta.url);
const { ComingSoonList } = await import("../src/components/ComingSoon.tsx");

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("each planned project is shown with what it will do and a Coming soon badge", () => {
  const html = renderToStaticMarkup(createElement(ComingSoonList, { onClose: () => {} }));
  const shown = text(html);
  for (const item of COMING_SOON) {
    assert.ok(shown.includes(item.title), item.title);
    assert.ok(shown.includes(item.about), item.about);
  }
  // One badge per card, besides the dialog's own title.
  assert.equal(html.match(/>Coming soon</g)?.length, COMING_SOON.length + 1);
  assert.ok(shown.includes("None of these work yet."), shown);
  // Nothing on it opens or runs anything: Close is its only button.
  assert.deepEqual([...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]), ["Close"]);
  assert.equal(html.match(/<button/g)?.length, 1);
});

test("nothing on the list is a feature Flash already offers", () => {
  const live = new Set(FEATURES.filter((f) => !f.soon).map((f) => f.title));
  for (const item of COMING_SOON) assert.ok(!live.has(item.title), item.title);
  assert.equal(new Set(COMING_SOON.map((i) => i.title)).size, COMING_SOON.length, "no project is listed twice");
});

test("its words make no claim Flash can't keep", () => {
  for (const item of COMING_SOON) {
    const words = `${item.title} ${item.about}`;
    assert.doesNotMatch(words, /quantum|holograph|chronos|cortex/i, item.title);
    assert.doesNotMatch(words, /compliant|guarantee/i, item.title);
  }
});
