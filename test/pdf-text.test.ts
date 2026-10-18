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
        assert.equal(reason.name, "AbortException", "the name pdf.js's worker takes as a quiet stop");
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

/** A real PDF in Helvetica, one page for each list of lines, made here so a big one needn't be kept. */
function makePdf(pages: string[][]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  pages.forEach((lines, i) => {
    const height = 40 + 10 * lines.length;
    const content = `BT /F1 8 Tf 10 TL 20 ${height - 20} Td\n${lines.map((l) => `(${l}) Tj T*`).join("\n")}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

test("a real PDF read with pdf.js gives the text of its pages read whole and cut, and a long page is read only up to the limit", async () => {
  const { CUT_NOTE, MAX_TEXT } = await import("../src/lib/office.ts");
  // A short page, a page of 4,000 lines (about 240,000 characters, past a chat's limit), and a short page.
  const pdf = makePdf([
    ["Golden Crumb, Montr\\351al", "A plan for the year ahead."],
    Array.from({ length: 4000 }, (_, n) => `Line ${n + 1}: Golden Crumb bakes rye and sourdough every morning.`),
    ["The last page."],
  ]);
  // How the chat read a PDF before #126 (each page whole, then cut), at any limit.
  const readWhole = async (limit: number) => {
    const task = pdfjs.getDocument({ data: pdf.slice() });
    const doc = await task.promise;
    const pages: string[] = [];
    let length = 0;
    for (let n = 1; n <= doc.numPages && length < limit; n++) {
      const text = pageText((await (await doc.getPage(n)).getTextContent()).items);
      pages.push(`--- Page ${n} ---\n${text}`);
      length += text.length;
    }
    await task.destroy();
    const text = pages.join("\n\n");
    return text.length > limit || pages.length < doc.numPages ? `${text.slice(0, limit)}${CUT_NOTE}` : text;
  };
  // pdf.js as pdfText uses it, counting the pages opened and the text pieces it sent.
  let opened: number[] = [];
  let pieces = 0;
  const counted = {
    getDocument: (src: { data: Uint8Array }) => {
      const task = pdfjs.getDocument(src);
      const promise = task.promise.then((doc) => ({
        numPages: doc.numPages,
        getPage: async (n: number) => {
          opened.push(n);
          const page = await doc.getPage(n);
          const count = new TransformStream<{ items: object[] }, { items: object[] }>({
            transform(chunk, controller) {
              pieces += chunk.items.length;
              controller.enqueue(chunk);
            },
          });
          return { streamTextContent: () => (page.streamTextContent() as unknown as ReadableStream<{ items: object[] }>).pipeThrough(count) };
        },
      }));
      return { promise, destroy: () => task.destroy() };
    },
  };
  const all = await readWhole(10_000_000);
  assert.match(all, /^--- Page 1 ---\nGolden Crumb, Montréal\nA plan for the year ahead\.\n\n--- Page 2 ---\nLine 1: Golden Crumb/);
  assert.ok(all.endsWith("Line 4000: Golden Crumb bakes rye and sourdough every morning.\n\n--- Page 3 ---\nThe last page."));
  assert.ok(all.length > MAX_TEXT);
  opened = [];
  pieces = 0;
  assert.equal(await pdfText(pdf.slice(), counted, 10_000_000), all, "read whole when it fits");
  assert.deepEqual(opened, [1, 2, 3]);
  const everyPiece = pieces;
  // What pdf.js says while the long page is cut part way (it logs to console.warn).
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    for (const limit of [300, 2_000, 20_000, MAX_TEXT]) {
      opened = [];
      pieces = 0;
      const text = await pdfText(pdf.slice(), counted, limit);
      assert.equal(text, await readWhole(limit), `the same text at ${limit} characters`);
      assert.ok(text.endsWith(CUT_NOTE));
      assert.deepEqual(opened, [1, 2], "the page after the cut isn't opened");
      assert.ok(pieces < everyPiece * (limit === MAX_TEXT ? 0.95 : 0.2), `${pieces} of ${everyPiece} pieces read at ${limit}`);
    }
    assert.equal(await pdfText(pdf.slice(), pdfjs), await readWhole(MAX_TEXT), "a chat's usual limit");
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    console.warn = warn;
  }
  // The stop is one pdf.js takes as its own. Before, its worker warned "ignoring errors during
  // GetTextContent ... UnknownErrorException: enough text" whenever the stop came before the page's end.
  assert.deepEqual(warnings.filter((w) => w.includes("enough text")), []);
});

test("the chat reads PDFs with pdf.js's legacy build, which needs no JavaScript newer than browsers have", async () => {
  const flash = readFileSync(new URL("../src/components/Flash.tsx", import.meta.url), "utf8");
  const readPdf = flash.slice(flash.indexOf("async function readPdf("), flash.indexOf("function readFile("));
  assert.match(readPdf, /await import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)/);
  assert.match(readPdf, /new URL\("pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs", import\.meta\.url\)/);
  assert.doesNotMatch(flash, /import\("pdfjs-dist"\)|"pdfjs-dist\/build\//, "nothing loads the modern build");
  // A PDF with only an owner password (it opens without one; AES-128, made by fpdf2). The modern build
  // can't read it where Map.prototype.getOrInsertComputed is missing (Chromium 141 among others); the
  // legacy build brings its own.
  const owner = new Uint8Array(readFileSync("test/fixtures/owner-password.pdf"));
  assert.equal(
    await pdfText(owner, pdfjs),
    "--- Page 1 ---\nOwner-password only, line 0: Golden Crumb, Montreal\nOwner-password only, line 1: Golden Crumb, Montreal\nOwner-password only, line 2: Golden Crumb, Montreal",
  );
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
