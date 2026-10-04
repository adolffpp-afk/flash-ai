import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { officeKind, officeText, MAX_TEXT, docxText } from "../src/lib/office.ts";

const inflate = async (data: Uint8Array) => new Uint8Array(inflateRawSync(data));
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("Office files are recognized by type or name", () => {
  assert.equal(officeKind("Menu.DOCX", ""), "docx");
  assert.equal(officeKind("x", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "xlsx");
  assert.equal(officeKind("deck.pptx", "application/octet-stream"), "pptx");
  assert.equal(officeKind("old.doc", "application/msword"), null);
  assert.equal(officeKind("notes.txt", "text/plain"), null);
});

test("a Word document becomes its paragraphs", async () => {
  assert.equal(await officeText(fixture("menu.docx"), "docx", inflate), "Golden Crumb Menu & Prices\nCroissant\t$3.50\nCafé au lait\nLine two");
});

test("an Excel workbook becomes one CSV block per sheet, with empty cells kept in place", async () => {
  assert.equal(
    await officeText(fixture("sales.xlsx"), "xlsx", inflate),
    '--- Sheet: October ---\nItem,Sold\nChocolate cake,,12.5\n"Croissant, plain",40\n\n--- Sheet: Notes & ideas ---\nOpen a second shop',
  );
});

test("a PowerPoint deck becomes its slides in order", async () => {
  assert.equal(
    await officeText(fixture("pitch.pptx"), "pptx", inflate),
    "--- Slide 1 ---\nGolden Crumb\n\n--- Slide 2 ---\nOur bread\nBaked daily\n\n--- Slide 3 ---\nThank you",
  );
});

test("files that aren't Office files, or have no text, are refused", async () => {
  await assert.rejects(officeText(new TextEncoder().encode("just text, not a zip"), "docx", inflate));
  await assert.rejects(officeText(fixture("menu.docx"), "pptx", inflate), /no text/);
});

test("very long documents are cut", () => {
  const long = `<w:p><w:t>${"word ".repeat(60_000)}</w:t></w:p>`;
  assert.ok(docxText(long).length > MAX_TEXT, "the cut happens in officeText");
});
