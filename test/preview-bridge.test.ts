import { test } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_BRIDGE, fixRequest, friendlyError, isPreviewMessage, linesIn, pickedContext } from "../src/lib/preview-bridge.ts";
import { flashDbShim } from "../src/lib/flashdb-shim.ts";
import { route } from "../src/lib/router.ts";

test("Fix it tells the builder the error and the line it happened on", () => {
  const html = "<html>\n<script>\nconst total = items.length;\n</script>\n</html>";
  const request = fixRequest([{ message: "items is not defined", line: 3 }], html);
  assert.match(request, /Fix this error in my app/);
  assert.match(request, /items is not defined/);
  assert.match(request, /Around line 3: const total = items\.length;/);
  assert.match(request, /keep everything else the same/);
});

test("Fix it sends up to three different errors, and no line when it doesn't know one", () => {
  const errors = [
    { message: "a is not defined", line: 0 },
    { message: "a is not defined", line: 0 },
    { message: "b broke", line: 999 },
    { message: "c broke", line: 1 },
    { message: "d broke", line: 1 },
  ];
  const request = fixRequest(errors, "<html>\n</html>");
  assert.match(request, /these errors/);
  assert.equal(request.match(/is not defined/g)?.length, 1, "the same error only once");
  assert.ok(!request.includes("Around line 999"), "a line past the end of the file is left out");
  assert.ok(!request.includes("d broke"), "at most three");
});

test("storage errors are explained in a way the builder can act on", () => {
  const storage = "Uncaught SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.";
  assert.match(friendlyError(storage), /built-in database \(flashDB\)/);
  assert.match(fixRequest([{ message: storage, line: 0 }], "<html>"), /built-in database/);
  assert.equal(friendlyError("items is not defined"), "items is not defined");
});

test("a part picked in the preview is described in the user's words", () => {
  const context = pickedContext({ tag: "button", text: "Book now", path: "section#home > button.cta", html: '<button class="cta">Book now</button>', label: 'button "Book now"' });
  assert.match(context, /Change only this part of the app, which I selected in the preview: the button "Book now"\./);
  assert.match(context, /Where it is: section#home > button\.cta/);
  assert.match(context, /Its HTML starts: <button class="cta">/);
});

test("only Flash's own preview messages are listened to", () => {
  assert.ok(isPreviewMessage({ flashPreview: true, type: "error" }));
  for (const other of [null, undefined, "hello", 7, {}, { type: "error" }, { flashPreview: "yes" }]) {
    assert.ok(!isPreviewMessage(other), JSON.stringify(other));
  }
});

test("error lines point at the app's own code, not Flash's scripts", () => {
  const head = PREVIEW_BRIDGE + flashDbShim(null);
  // The scripts Flash adds are counted, so line 1 of the app stays line 1 for the builder.
  assert.ok(linesIn(head) > 50, "the bridge is many lines long");
  assert.equal(linesIn("one\ntwo\nthree"), 2);
  assert.equal(linesIn("<script>x</script>"), 0);
  // Nothing in the bridge can be the app's own markup.
  assert.ok(head.startsWith("<script>"));
  assert.ok(head.trimEnd().endsWith("</script>"));
});

test("the bridge is only in the preview: published apps get the database alone", () => {
  assert.ok(!flashDbShim("/api/db/abc", "/api/inbox", "/api/shop").includes("flashPreview"));
  assert.match(PREVIEW_BRIDGE, /unhandledrejection/);
  assert.match(PREVIEW_BRIDGE, /crosshair/);
});

test("a screenshot or sketch with a build request goes to the builder", () => {
  for (const ask of [
    "turn this screenshot into a website",
    "build me an app that looks like this",
    "make this sketch into a working web page",
    "recreate this design as html",
    "clone this site",
  ]) {
    assert.equal(route(ask, "image/png").engine, "app", ask);
  }
  assert.equal(route("turn this into a presentation", "image/jpeg").engine, "slides");
  // Photos are still edited, read and asked about as before.
  assert.equal(route("remove the background", "image/png").engine, "image");
  assert.equal(route("make it black and white", "image/png").engine, "image");
  assert.equal(route("what is in this picture?", "image/png").engine, "text");
  assert.equal(route("copy the text into a spreadsheet", "image/png").engine, "docs");
  assert.equal(route("animate this photo", "image/png").engine, "video");
  // Without a picture, nothing changes.
  assert.equal(route("build me a website for my bakery").engine, "app");
});
