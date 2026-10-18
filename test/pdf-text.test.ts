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

test("an assistant's file keeps up to the limit it's given, and a chat's the usual 200,000 characters, each with the cut note within it", async () => {
  const { CUT_NOTE, MAX_TEXT } = await import("../src/lib/office.ts");
  const { MAX_FILE_CHARS, READ_LIMIT } = await import("../src/lib/assistants.ts");
  // 40 pages of 50,000 characters: 2,000,000 in all.
  let read = 0;
  const pages = (count: number) => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: count,
        getPage: async (n: number) => {
          read++;
          return { getTextContent: async () => ({ items: [{ str: `${n}`.padEnd(50_000, "x") }] }) };
        },
      }),
      destroy: async () => {},
    }),
  });
  const chat = await pdfText(new Uint8Array(), pages(40));
  assert.equal(chat.length, MAX_TEXT + CUT_NOTE.length);
  assert.ok(chat.endsWith(CUT_NOTE));
  assert.equal(read, 4, "pages past the limit aren't read");
  read = 0;
  const kept = await pdfText(new Uint8Array(), pages(40), READ_LIMIT);
  assert.equal(kept.length, MAX_FILE_CHARS, "an assistant's file fits its limit, note and all");
  assert.ok(kept.endsWith(CUT_NOTE));
  assert.match(kept, /--- Page 20 ---\n20x/);
  assert.doesNotMatch(kept, /--- Page 21 ---/);
  assert.equal(read, 20);
  const whole = await pdfText(new Uint8Array(), pages(3), READ_LIMIT);
  assert.ok(!whole.includes(CUT_NOTE), "nothing cut, no note");
  assert.match(whole, /^--- Page 1 ---\n1x+\n\n--- Page 2 ---/);
});
