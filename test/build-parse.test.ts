import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlTitle, splitBuild } from "../src/lib/build-parse.ts";

test("finds the html block and the prose around it", () => {
  const r = splitBuild("Built it.\n\n```html\n<!doctype html><title>Todo</title>\n```\n\n- Add tags");
  assert.equal(r.before, "Built it.\n\n");
  assert.equal(r.html, "<!doctype html><title>Todo</title>");
  assert.equal(r.after.trim(), "- Add tags");
  assert.equal(r.open, false);
});

test("reports an unfinished block while streaming", () => {
  const r = splitBuild("Here.\n```html\n<div>");
  assert.equal(r.open, true);
  assert.equal(r.html, "<div>");
});

test("no block means no app", () => {
  assert.equal(splitBuild("Just text").html, null);
});

test("reads the page title", () => {
  assert.equal(htmlTitle("<title> Snake </title>", "x"), "Snake");
  assert.equal(htmlTitle("<p>hi</p>", "Your app"), "Your app");
});
