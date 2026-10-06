import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/lib/router.ts";
import { PHOTO_ACTIONS, photoActionsFor } from "../src/lib/photo-actions.ts";
import { system } from "../src/lib/engines/claude.ts";
import { cellValue, csvRows, excelWorkbook } from "../src/lib/excel-export.ts";
import { freeEligible } from "../src/lib/engines/free.ts";

test("asking for a photo's text goes to Docs & Sheets, not to photo editing or transcription", () => {
  for (const ask of [
    "Turn this receipt into a spreadsheet",
    "Transcribe this handwritten note",
    "put this in an excel sheet",
    "Convert this menu to a Word document",
    "make it a csv",
    "list the items on this receipt",
    "Copy the text",
    "scan this document",
    "Extract the numbers",
    "turn it into text",
  ]) {
    assert.equal(route(ask, "image/jpeg").engine, "docs", ask);
  }
  // Changing the words in the picture is still an edit, and questions about it still get answers.
  assert.equal(route("Add the text 'Grand opening' at the top", "image/jpeg").engine, "image");
  assert.equal(route("Remove the text from this photo", "image/png").engine, "image");
  assert.equal(route("Make the text bigger", "image/png").engine, "image");
  assert.equal(route("Turn this into a cartoon", "image/jpeg").engine, "image");
  assert.equal(route("Put a table and two chairs in this room", "image/jpeg").engine, "image");
  assert.equal(route("What does this sign say?", "image/jpeg").engine, "text");
  assert.equal(route("Translate the text in this photo to English", "image/jpeg").engine, "translate");
  // A GIF can't be edited, but it can be read.
  assert.equal(route("Copy all the text", "image/gif").engine, "docs");
  // Recordings are still transcribed as recordings.
  assert.equal(route("Transcribe this interview", "audio/mpeg").engine, "transcribe");
});

test("every photo button goes to the tool it is for, on Auto", () => {
  for (const a of PHOTO_ACTIONS) {
    assert.equal(route(a.prompt, "image/jpeg").engine, a.engine, a.label);
    if (a.several) assert.equal(route(a.several, "image/jpeg").engine, a.engine, `${a.label} (several)`);
  }
});

test("reading buttons show for one or several photos; editing ones only for one photo Flash can edit", () => {
  const labels = (types: string[], live: (engine: string) => boolean = () => true) => photoActionsFor(types, live).map((a) => a.label);
  assert.deepEqual(labels(["image/jpeg"]), PHOTO_ACTIONS.map((a) => a.label));
  assert.deepEqual(labels(["image/jpeg", "image/png", "image/webp"]), ["📄 Copy the text", "📊 Make a spreadsheet"]);
  assert.deepEqual(labels(["image/gif"]), ["📄 Copy the text", "📊 Make a spreadsheet"]);
  assert.deepEqual(labels(["image/jpeg", "application/pdf"]), [], "not when a file isn't a photo");
  assert.deepEqual(labels([]), []);
  assert.deepEqual(labels(["image/jpeg"], (e) => e === "docs"), ["📄 Copy the text", "📊 Make a spreadsheet"], "only tools that are live");
});

test("Docs & Sheets copies text exactly, marks what it can't read, and gives rows as a spreadsheet", () => {
  const prompt = system("", "docs");
  assert.match(prompt, /copy the words exactly as written/);
  assert.match(prompt, /\[unclear\]/);
  assert.match(prompt, /never guess a number/);
  assert.match(prompt, /amounts as plain numbers and the currency in its own column/);
  // Out of credits, the free models can't see pictures, so photos never go to them.
  assert.equal(freeEligible("docs", { role: "user", content: "Copy the text", attachment: { name: "r.jpg", mediaType: "image/jpeg", data: "" } }), null);
});

test("a CSV block becomes spreadsheet rows, with quoted commas, quotes and line breaks kept", () => {
  const csv = 'Date,Item,Qty,Price,Currency\r\n2026-10-04,"Bread, honey oat",2,8.00,CAD\n2026-10-04,"The ""big"" loaf",1,12.5,CAD\n\n,"Note:\nline two",,,\n';
  assert.deepEqual(csvRows(csv), [
    ["Date", "Item", "Qty", "Price", "Currency"],
    ["2026-10-04", "Bread, honey oat", "2", "8.00", "CAD"],
    ["2026-10-04", 'The "big" loaf', "1", "12.5", "CAD"],
    ["", "Note:\nline two", "", "", ""],
  ]);
  assert.deepEqual(cellValue("8.00"), { number: 8, style: 0 }, "amounts arrive in Excel as numbers");
  const book = excelWorkbook([{ name: "Sheet1", rows: csvRows(csv) }]);
  assert.ok(book.length > 500 && book[0] === 0x50 && book[1] === 0x4b, "a real .xlsx (zip) file");
});
