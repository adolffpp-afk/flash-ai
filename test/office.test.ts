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

/** A zip archive of these files, stored without compression, as readZip reads them. */
function zipOf(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(at, 42);
    parts.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    at += local.length + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

test("an assistant's file keeps up to the limit it's given, and a chat's the usual 200,000 characters, each with the cut note within it", async () => {
  const { CUT_NOTE } = await import("../src/lib/office.ts");
  const { MAX_FILE_CHARS, READ_LIMIT } = await import("../src/lib/assistants.ts");
  const paragraphs = (chars: number) => Array.from({ length: Math.ceil(chars / 1000) }, (_, i) => `<w:p><w:t>${`${i}`.padEnd(999, "y")}</w:t></w:p>`).join("");
  const long = zipOf({ "word/document.xml": paragraphs(1_500_000) });
  const chat = await officeText(long, "docx", inflate);
  assert.equal(chat.length, MAX_TEXT + CUT_NOTE.length);
  assert.ok(chat.endsWith(CUT_NOTE));
  const kept = await officeText(long, "docx", inflate, READ_LIMIT);
  assert.equal(kept.length, MAX_FILE_CHARS, "an assistant's file fits its limit, note and all");
  assert.ok(kept.endsWith(CUT_NOTE));
  const fits = await officeText(zipOf({ "word/document.xml": paragraphs(600_000) }), "docx", inflate, READ_LIMIT);
  assert.ok(fits.length > MAX_TEXT && !fits.includes(CUT_NOTE), "600,000 characters fit whole");
});
