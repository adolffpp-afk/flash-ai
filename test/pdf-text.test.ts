import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pageText, pdfText } from "../src/lib/pdf-text.ts";

test("a PDF's text is read page by page", async () => {
  const text = await pdfText(new Uint8Array(readFileSync("test/fixtures/plan.pdf")), pdfjs);
  assert.match(text, /^--- Page 1 ---\nBakery business plan\nGolden Crumb sells fresh bread in Montréal\.\nCosts\n/);
  assert.match(text, /Item Monthly\nRent \$2,400\nFlour \$600\n/);
});

test("text pieces join into lines", () => {
  assert.equal(pageText([{ str: "Hello", hasEOL: false }, { str: " world  ", hasEOL: true }, { str: "", hasEOL: true }, { str: "", hasEOL: true }, { str: "Bye" }]), "Hello world\n\nBye");
});

test("a scanned PDF with no text says so", async () => {
  const empty = { getDocument: () => ({ promise: Promise.resolve({ numPages: 2, getPage: async () => ({ getTextContent: async () => ({ items: [] }) }) }), destroy: async () => {} }) };
  await assert.rejects(pdfText(new Uint8Array(), empty), /no text found/);
});
