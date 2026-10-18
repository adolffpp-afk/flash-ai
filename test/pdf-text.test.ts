import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pageText, pdfText } from "../src/lib/pdf-text.ts";

/**
 * A page as pdf.js gives it: its text pieces streamed a hundred at a time (made as they're asked
 * for), and getTextContent reading them all, as pdf.js's own does.
 */
function textPage(items: (i: number) => object | null, seen = { pulled: 0, cancelled: false }) {
  const streamTextContent = () => {
    let i = 0;
    return new ReadableStream<{ items: object[] }>({
      pull(controller) {
        const chunk: object[] = [];
        for (let item; chunk.length < 100 && (item = items(i)); i++) chunk.push(item);
        seen.pulled += chunk.length;
        if (chunk.length) controller.enqueue({ items: chunk });
        else controller.close();
      },
      cancel(reason) {
        assert.ok(reason instanceof Error, "pdf.js wants an Error to stop");
        seen.cancelled = true;
      },
    });
  };
  return {
    streamTextContent,
    getTextContent: async () => {
      const all: object[] = [];
      const reader = streamTextContent().getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) all.push(...next.value.items);
      return { items: all };
    },
  };
}

test("a PDF's text is read page by page", async () => {
  const text = await pdfText(new Uint8Array(readFileSync("test/fixtures/plan.pdf")), pdfjs);
  assert.match(text, /^--- Page 1 ---\nBakery business plan\nGolden Crumb sells fresh bread in Montréal\.\nCosts\n/);
  assert.match(text, /Item Monthly\nRent \$2,400\nFlour \$600\n/);
});

test("text pieces join into lines", () => {
  assert.equal(pageText([{ str: "Hello", hasEOL: false }, { str: " world  ", hasEOL: true }, { str: "", hasEOL: true }, { str: "", hasEOL: true }, { str: "Bye" }]), "Hello world\n\nBye");
});

test("a scanned PDF with no text says so", async () => {
  const empty = { getDocument: () => ({ promise: Promise.resolve({ numPages: 2, getPage: async () => textPage(() => null) }), destroy: async () => {} }) };
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
          return textPage((i) => (i ? null : { str: `${n}`.padEnd(50_000, "x") }));
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

test("a page is read only up to the limit: once its text is past it, pdf.js is told to stop, and no page after it is opened", async () => {
  const { CUT_NOTE } = await import("../src/lib/office.ts");
  // One page of 2,000,000 pieces of 40 characters, 80,000,000 in all, and a second page.
  const seen = { pulled: 0, cancelled: false };
  const piece = { str: "A".repeat(40), hasEOL: true };
  let opened = 0;
  const lib = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (n: number) => {
          opened = n;
          return textPage((i) => (i < 2_000_000 ? piece : null), seen);
        },
      }),
      destroy: async () => {},
    }),
  };
  for (const limit of [10, 200_000]) {
    seen.pulled = 0;
    seen.cancelled = false;
    const text = await pdfText(new Uint8Array(), lib, limit);
    assert.ok(seen.pulled <= limit / 40 + 300, `${seen.pulled} pieces read for ${limit} characters`);
    assert.ok(seen.cancelled, "the rest of the page is left unread");
    assert.equal(opened, 1, "the next page isn't opened");
    const lines = `--- Page 1 ---\n${`${"A".repeat(40)}\n`.repeat(limit / 40 + 1)}`;
    assert.equal(text, `${lines.slice(0, limit)}${CUT_NOTE}`, "the text up to the limit, and the note");
  }
  // Pieces that are mostly spaces, which pageText takes out of the end of a line, don't count: the
  // page keeps the limit's characters all the same, and the rest of it is still left unread.
  const spaced = { str: `A${" ".repeat(39)}`, hasEOL: true };
  const read = { pulled: 0, cancelled: false };
  const one = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => textPage((i) => (i < 2_000_000 ? spaced : null), read) }), destroy: async () => {} }) };
  const cut = await pdfText(new Uint8Array(), one, 200_000);
  assert.equal(cut, `${`--- Page 1 ---\n${"A\n".repeat(200_000)}`.slice(0, 200_000)}${CUT_NOTE}`);
  assert.ok(read.cancelled && read.pulled < 500_000, `${read.pulled} of 2,000,000 pieces read`);
  // A page that fits is read to its end, and isn't marked cut.
  const short = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => textPage((i) => (i < 3 ? piece : null)) }), destroy: async () => {} }) };
  assert.equal(await pdfText(new Uint8Array(), short), `--- Page 1 ---\n${["A".repeat(40), "A".repeat(40), "A".repeat(40)].join("\n")}`);
});

test("what pageText takes out (spaces before a line's end, blank lines past two) doesn't count toward the limit: the text is the page's read whole, cut to the limit", async () => {
  const { CUT_NOTE, MAX_TEXT } = await import("../src/lib/office.ts");
  const seen = { pulled: 0, cancelled: false };
  const one = (items: (i: number) => object | null) => ({
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => textPage(items, seen) }), destroy: async () => {} }),
  });
  // The page read whole, as before pdfText stopped part way.
  const whole = (items: (i: number) => object | null) => {
    const all: object[] = [];
    for (let i = 0, item; (item = items(i)); i++) all.push(item);
    return `--- Page 1 ---\n${pageText(all)}`;
  };
  // A report whose lines are padded to 80 columns, with two blank lines after each: 83 characters a
  // line in its pieces, but about 16 in its text. 5,000 lines are more than a chat's 200,000 in
  // their pieces, but fit.
  const report = (lines: number) => (i: number) => (i >= 3 * lines ? null : i % 3 ? { str: "", hasEOL: true } : { str: `Rye loaf ${i / 3}`.padEnd(80), hasEOL: true });
  const fits = await pdfText(new Uint8Array(), one(report(5_000)));
  assert.ok(fits.length < MAX_TEXT / 2);
  assert.equal(fits, whole(report(5_000)), "read whole, and not marked cut");
  // 50,000 of them don't: cut at the limit, and the rest of the page isn't read.
  seen.pulled = 0;
  seen.cancelled = false;
  const long = await pdfText(new Uint8Array(), one(report(50_000)));
  assert.equal(long, `${whole(report(50_000)).slice(0, MAX_TEXT)}${CUT_NOTE}`);
  assert.ok(seen.cancelled, "the rest of the page is left unread");
  assert.ok(seen.pulled < 75_000, `${seen.pulled} of 150,000 pieces read`);
  // A page whose first pieces are more blank lines than the limit has its text all the same.
  const blank = (i: number) => (i < 100_100 ? { str: " ", hasEOL: true } : i === 100_100 ? { str: "Golden Crumb" } : null);
  assert.equal(await pdfText(new Uint8Array(), one(blank)), "--- Page 1 ---\nGolden Crumb");
});
