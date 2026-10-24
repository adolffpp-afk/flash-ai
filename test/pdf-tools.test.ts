import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  CANT_FLATTEN,
  LOCKED,
  PDF_TOOLS,
  PdfToolError,
  UNREADABLE,
  everyPage,
  fillForm,
  formFields,
  mergePdfs,
  numberPages,
  outName,
  pageCount,
  parseRanges,
  photosToPdf,
  pickPages,
  splitPdf,
  uniquePages,
} from "../src/lib/pdf-tools.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A PDF of `pages` pages, each as wide as 100 plus its number, so a page can be told by its width. */
async function pdfOf(pages: number, first = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([100 + first + i, 200]);
  return doc.save();
}
/** A plain grey PNG of w x h pixels. */
function png(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8; // 8 bits, greyscale
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array(w).fill(128)])));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}
const widths = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth() - 100);

test("the tools are listed once each, with short lines", () => {
  assert.equal(new Set(PDF_TOOLS.map((t) => t.id)).size, PDF_TOOLS.length);
  for (const tool of PDF_TOOLS) assert.ok(tool.about.length <= 70, tool.title);
});

test("a page range names pages in the order written, and nothing past the end", () => {
  assert.deepEqual(parseRanges("1-3, 5", 10), [[1, 2, 3], [5]]);
  assert.deepEqual(parseRanges("8-", 10), [[8, 9, 10]]);
  assert.deepEqual(parseRanges("-2;4", 10), [[1, 2], [4]]);
  assert.deepEqual(parseRanges("3 – 4", 10), [[3, 4]], "an en dash works too");
  assert.equal(parseRanges("11", 10), null);
  assert.equal(parseRanges("5-3", 10), null);
  assert.equal(parseRanges("0", 10), null);
  assert.equal(parseRanges("two", 10), null);
  assert.equal(parseRanges(" , ", 10), null);
  assert.deepEqual(uniquePages([[1, 2], [2, 3]]), [1, 2, 3]);
  assert.deepEqual(everyPage(3), [[1], [2], [3]]);
});

test("merge joins PDFs in the order given", async () => {
  const merged = await mergePdfs([await pdfOf(2, 1), await pdfOf(1, 7)]);
  assert.deepEqual(await widths(merged), [1, 2, 7]);
});

test("organize keeps the pages picked, in that order, turned on top of how they were", async () => {
  const doc = await PDFDocument.load(await pdfOf(3));
  doc.getPage(2).setRotation({ type: "degrees", angle: 90 } as never);
  const out = await PDFDocument.load(await pickPages(await doc.save(), [{ page: 3, turn: 90 }, { page: 1, turn: -90 }]));
  assert.deepEqual(out.getPages().map((p) => p.getWidth() - 100), [3, 1]);
  assert.deepEqual(out.getPages().map((p) => p.getRotation().angle), [180, 270]);
});

test("split makes one PDF for each range", async () => {
  const parts = await splitPdf(await pdfOf(5), [[1, 2], [5]]);
  assert.equal(parts.length, 2);
  assert.deepEqual(await widths(parts[0]), [1, 2]);
  assert.deepEqual(await widths(parts[1]), [5]);
});

test("a form's fields are read and filled, kept editable or flattened", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField("name").addToPage(page, { x: 10, y: 300, width: 200, height: 20 });
  form.createCheckBox("agree").addToPage(page, { x: 10, y: 250, width: 15, height: 15 });
  const dd = form.createDropdown("size");
  dd.addOptions(["S", "M", "L"]);
  dd.addToPage(page, { x: 10, y: 200, width: 100, height: 20 });
  const locked = form.createTextField("id");
  locked.addToPage(page, { x: 10, y: 150, width: 100, height: 20 });
  locked.enableReadOnly();
  form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
  const bytes = await doc.save();

  assert.deepEqual(await formFields(bytes), [
    { name: "name", kind: "text", value: "", multiline: false },
    { name: "agree", kind: "check", value: false },
    { name: "size", kind: "choice", value: "", options: ["S", "M", "L"] },
  ]);
  const filled = await fillForm(bytes, { name: "Ana", agree: true, size: "M", id: "x", unknown: "y" }, false);
  assert.deepEqual(
    (await formFields(filled)).map((f) => f.value),
    ["Ana", true, "M"],
  );
  assert.equal((await PDFDocument.load(filled)).getForm().getTextField("id").getText(), undefined, "a read-only field is left alone");
  const flat = await fillForm(bytes, { name: "Ana" }, true);
  assert.equal((await PDFDocument.load(flat)).getForm().getFields().length, 0, "flattened: the answers are part of the page");
  // Letters the form's font can't write still go in: the reader draws them.
  const greek = await fillForm(bytes, { name: "Ελένη" }, false);
  assert.equal((await formFields(greek))[0].value, "Ελένη");
  await assert.rejects(fillForm(bytes, { name: "Ελένη" }, true), (e) => e instanceof PdfToolError && e.message === CANT_FLATTEN);
});

test("page numbers are added to every page from the one asked", async () => {
  const numbered = await numberPages(await pdfOf(3), "center", 2);
  assert.equal(await pageCount(numbered), 3);
  assert.ok(numbered.length > (await pdfOf(3)).length);
  const doc = await PDFDocument.load(await pdfOf(2));
  doc.getPage(1).setRotation({ type: "degrees", angle: 90 } as never);
  assert.equal(await pageCount(await numberPages(await doc.save(), "right")), 2, "turned pages are numbered too");
});

test("photos become A4 pages turned the way each photo is", async () => {
  const out = await PDFDocument.load(await photosToPdf([{ bytes: png(2, 1), type: "png" }, { bytes: png(1, 2), type: "png" }]));
  const sizes = out.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  assert.deepEqual(sizes, [[842, 595], [595, 842]]);
});

test("a locked or broken PDF says why it can't be opened", async () => {
  await assert.rejects(pageCount(new TextEncoder().encode("not a pdf")), (e) => e instanceof PdfToolError && e.message === UNREADABLE);
  const locked = fixture("owner-password.pdf");
  await assert.rejects(pickPages(locked, [{ page: 1, turn: 0 }]), (e) => e instanceof PdfToolError && e.message === LOCKED);
});

test("what a tool makes is named after the first file", () => {
  assert.equal(outName("Contract v2.pdf", "merged"), "Contract v2-merged.pdf");
  assert.equal(outName("a/b:c.pdf", "part", 2), "a-b-c-part-2.pdf");
  assert.equal(outName(".pdf", "pages"), "document-pages.pdf");
});
