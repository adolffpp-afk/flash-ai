import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, hasPieces, piecesIn, splitEdits } from "../src/lib/edit-blocks.ts";
import { buildSystem, EDIT_RULES } from "../src/lib/engines/builder.ts";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Bakery</title>
    <style>
      .btn { background: #d97706; }
    </style>
  </head>
  <body>
    <h1>Golden Crumb</h1>
    <button class="btn">Order</button>
    <p>Open every day.</p>
  </body>
</html>`;

const block = (...pieces: [string, string][]) =>
  "```flash-edit\n" +
  pieces.map(([find, replace]) => `<<<<<<< FIND\n${find}\n=======\n${replace}\n>>>>>>> REPLACE`).join("\n") +
  "\n```";

test("a small change comes back as pieces, with the sentence around them", () => {
  const reply = `I made the button green.\n\n${block(["      .btn { background: #d97706; }", "      .btn { background: #16a34a; }"])}\n\n- Add a photo of the shop`;
  const { before, edits, after, open } = splitEdits(reply);
  assert.equal(before.trim(), "I made the button green.");
  assert.equal(edits.length, 1);
  assert.equal(open, false);
  assert.equal(after.trim(), "- Add a photo of the shop");

  const { html, applied, failed } = applyEdits(PAGE, edits);
  assert.equal(applied, 1);
  assert.deepEqual(failed, []);
  assert.match(html, /background: #16a34a;/);
  assert.ok(!html.includes("#d97706"), "the old colour is gone");
  assert.ok(html.includes("<h1>Golden Crumb</h1>"), "nothing else moved");
});

test("several places change at once, and a piece can add or remove lines", () => {
  const edits = splitEdits(
    block(
      ["    <title>Bakery</title>", "    <title>Golden Crumb</title>"],
      ["    <h1>Golden Crumb</h1>", "    <h1>Golden Crumb</h1>\n    <p>Fresh since 1998</p>"],
      ["    <p>Open every day.</p>", ""],
    ),
  ).edits;
  const { html, applied, failed } = applyEdits(PAGE, edits);
  assert.equal(applied, 3);
  assert.deepEqual(failed, []);
  assert.match(html, /<title>Golden Crumb<\/title>/);
  assert.match(html, /Fresh since 1998/);
  assert.ok(!html.includes("Open every day."), "a piece replaced by nothing deletes the line");
});

test("lines quoted with the wrong indentation still find their place", () => {
  const { html, applied, failed } = applyEdits(PAGE, splitEdits(block(["<button class=\"btn\">Order</button>", "<button class=\"btn\">Order now</button>"])).edits);
  assert.equal(applied, 1);
  assert.deepEqual(failed, []);
  assert.match(html, /^ {4}<button class="btn">Order now<\/button>$/m, "and keep the file's own indentation around it");
});

test("a change that can't be placed safely is reported instead of guessed", () => {
  const twice = "<p>Hi</p>\n<p>Hi</p>";
  const ambiguous = applyEdits(twice, splitEdits(block(["<p>Hi</p>", "<p>Hello</p>"])).edits);
  assert.equal(ambiguous.applied, 0);
  assert.equal(ambiguous.failed.length, 1);
  assert.equal(ambiguous.html, twice, "a file that can't be changed is left exactly as it was");

  const invented = applyEdits(PAGE, splitEdits(block(["    <h2>Cakes</h2>", "    <h2>Breads</h2>"])).edits);
  assert.equal(invented.failed.length, 1, "lines that aren't in the file never match");

  const empty = applyEdits(PAGE, splitEdits(block(["   ", "<p>new</p>"])).edits);
  assert.equal(empty.failed.length, 1, "and neither does nothing at all");
});

test("a block still being written is held back, and a reply with none is just words", () => {
  const half = `Changing the colour.\n\n\`\`\`flash-edit\n<<<<<<< FIND\n      .btn { background: #d97706; }\n=======\n      .btn { background`;
  const cut = splitEdits(half);
  assert.equal(cut.open, true);
  assert.equal(cut.edits.length, 0, "an unfinished piece is not a change");

  const words = splitEdits("Which colour would you like?");
  assert.equal(words.before, "Which colour would you like?");
  assert.deepEqual(words.edits, []);
  assert.equal(words.open, false);
});

test("the builder is only told about pieces once there is an app to change", () => {
  assert.ok(!buildSystem("app", "").includes("flash-edit"), "a first build always sends the whole file");
  const editing = buildSystem("app", "Call me Adolff", true);
  assert.ok(editing.includes(EDIT_RULES));
  assert.match(editing, /About the user:\nCall me Adolff/);
  assert.ok(buildSystem("slides", "", true).includes("flash-edit"), "decks change the same way");
});

test("a piece replaced by nothing never swallows the piece after it", () => {
  const reply =
    "```flash-edit\n<<<<<<< FIND\n    <p>Open every day.</p>\n=======\n>>>>>>> REPLACE\n" +
    "<<<<<<< FIND\n    <title>Bakery</title>\n=======\n    <title>Golden Crumb</title>\n>>>>>>> REPLACE\n```";
  const { edits, broken } = splitEdits(reply);
  assert.deepEqual(edits, [
    { find: "    <p>Open every day.</p>", replace: "" },
    { find: "    <title>Bakery</title>", replace: "    <title>Golden Crumb</title>" },
  ]);
  assert.equal(broken, 0);
  const { html, failed } = applyEdits(PAGE, edits);
  assert.deepEqual(failed, []);
  assert.ok(!/<{5}|={7}|>{5}/.test(html), "no markers end up in the app");
});

test("``` inside a piece is code, and the block ends only between pieces", () => {
  const code = "    <pre>\n```\nnpm start\n```\n    </pre>";
  const reply = `Added the install steps.\n\n\`\`\`flash-edit\n<<<<<<< FIND\n    <p>Open every day.</p>\n=======\n${code}\n>>>>>>> REPLACE\n\`\`\`\n\nAnything else?`;
  const { before, edits, after, open, broken } = splitEdits(reply);
  assert.equal(before, "Added the install steps.\n\n");
  assert.deepEqual(edits, [{ find: "    <p>Open every day.</p>", replace: code }]);
  assert.equal(after.trim(), "Anything else?");
  assert.equal(open, false);
  assert.equal(broken, 0);
});

test("markers out of place are counted, so a half-read change is never made", () => {
  const stray = splitEdits("```flash-edit\n=======\n<p>x</p>\n>>>>>>> REPLACE\n```");
  assert.equal(stray.edits.length, 0);
  assert.ok(stray.broken > 0);
  const noSplit = splitEdits("```flash-edit\n<<<<<<< FIND\n<p>a</p>\n>>>>>>> REPLACE\n```");
  assert.ok(noSplit.broken > 0, "a piece missing its ======= line");
  const cut = splitEdits("```flash-edit\n<<<<<<< FIND\n<p>a</p>\n=======\n<p>b</p>");
  assert.equal(cut.edits.length, 0);
  assert.ok(cut.broken > 0, "a piece cut off halfway");
  assert.equal(splitEdits("```flash-edit\n```").found, true, "an empty block is still a block");
  assert.equal(splitEdits("no block here").found, false);
});

test("SEARCH works like FIND, and several blocks are read together", () => {
  const reply =
    "One.\n```flash-edit\n<<<<<<< SEARCH\n<b>1</b>\n=======\n<b>2</b>\n>>>>>>> REPLACE\n```\nAnd two.\n" +
    "```flash-edit\n<<<<<<< FIND\n<i>1</i>\n=======\n<i>2</i>\n>>>>>>> REPLACE\n```\nDone.";
  const { before, edits, after, broken } = splitEdits(reply);
  assert.equal(before, "One.\n");
  assert.equal(edits.length, 2);
  assert.equal(broken, 0);
  assert.equal(after, "Done.");
});

test("pieces sent inside an html block are read as pieces", () => {
  assert.equal(hasPieces(PAGE), false, "a whole file has no pieces");
  const code = "<<<<<<< FIND\n    <h1>Golden Crumb</h1>\n=======\n    <h1>Golden Crumb Bakery</h1>\n>>>>>>> REPLACE";
  assert.equal(hasPieces(code), true);
  const { edits, broken } = piecesIn(code);
  assert.equal(broken, 0);
  assert.match(applyEdits(PAGE, edits).html, /<h1>Golden Crumb Bakery<\/h1>/);
});
