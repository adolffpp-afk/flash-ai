/*
 * The Review automation card under a chat answer (plan §1.1, PR 2b): the price it shows, that results
 * show in Flash, Set it up myself in place of Automate this, and no card while the answer is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "../src/lib/store.ts";

register("./support/tsx-hooks.mjs", import.meta.url);
const { Message } = await import("../src/components/Message.tsx");

const answer: UIMessage = { id: "a1", role: "assistant", content: "This week's five electric car news points.", engine: "search" };
const noop = () => {};
const render = (m: UIMessage, o: { price?: number; automate?: boolean } = {}) =>
  renderToStaticMarkup(createElement(Message, { m, onAutomate: o.automate === false ? undefined : noop, review: o.price === undefined ? undefined : { price: o.price, onReview: noop } }));

test("the card shows its price, says results show in Flash, and takes Automate this's place as Set it up myself", () => {
  const one = render(answer, { price: 1 });
  for (const words of ["Flash can do this for you by itself, on a schedule.", "You&#x27;ll see results when you open Flash", "Turning this into steps costs 1 credit.", "Review automation", "Set it up myself"]) {
    assert.ok(one.includes(words), words);
  }
  assert.equal(one.includes("Automate this"), false, "Automate this is in the card, as Set it up myself");
  assert.ok(render(answer, { price: 3 }).includes("Turning this into steps costs 3 credits."));
  assert.equal(render(answer, { price: 1, automate: false }).includes("Set it up myself"), false, "only where Automate this could open the editor");
});

test("no card while the answer is being written, or without a price; Automate this stays as it was", () => {
  assert.equal(render({ ...answer, pending: true }, { price: 1 }).includes("Review automation"), false);
  const plain = render(answer);
  assert.equal(plain.includes("Review automation"), false);
  assert.ok(plain.includes("Automate this"));
});
