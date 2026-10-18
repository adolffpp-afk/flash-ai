/*
 * The text of a PDF, read in the browser with pdf.js. Small PDFs are sent whole so Flash sees
 * their pictures and layout too; bigger ones (up to MAX_PDF_MB) send only their text.
 */
import { CUT_NOTE, MAX_TEXT } from "./office.ts";

export const MAX_PDF_MB = 30;

type TextItem = { str?: string; hasEOL?: boolean };
type PdfPage = { streamTextContent: () => ReadableStream<{ items: object[] }> };
type PdfLib = {
  getDocument: (src: { data: Uint8Array }) => {
    promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPage> }>;
    destroy: () => Promise<void>;
  };
};

/** One page's text pieces as lines. */
export function pageText(items: object[]): string {
  return (items as TextItem[])
    .map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : ""))
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A page's text pieces as pdf.js sends them, a hundred or so at a time, until they hold more than
 * `room` characters (cut). Then pdf.js is told to stop, so the rest of the page isn't read.
 */
async function pageItems(page: PdfPage, room: number): Promise<{ items: object[]; cut: boolean }> {
  const reader = page.streamTextContent().getReader();
  const items: object[] = [];
  let chars = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { items, cut: false };
      for (const item of value.items) {
        items.push(item);
        chars += ((item as TextItem).str ?? "").length + ((item as TextItem).hasEOL ? 1 : 0);
      }
      if (chars > room) return { items, cut: true };
    }
  } finally {
    // pdf.js wants an Error as the reason: without one, it goes on sending into a closed stream.
    reader.cancel(new Error("enough text")).catch(() => {});
  }
}

/**
 * A PDF's text, page by page, cut to `limit` characters (a chat's MAX_TEXT unless given), with
 * CUT_NOTE after a cut. Once the text is past the limit, no more of it is read: not the rest of
 * that page, nor the pages after it. That bounds the text, not all the work: pdf.js unpacks a
 * page's content whole before it sends any of its text, and a page whose content is mostly not
 * text takes as long as that content does. Throws when it has no text (a scan).
 */
export async function pdfText(bytes: Uint8Array, lib: PdfLib, limit = MAX_TEXT): Promise<string> {
  const task = lib.getDocument({ data: bytes });
  const doc = await task.promise;
  const pages: string[] = [];
  let length = 0;
  let cut = false;
  try {
    for (let n = 1; n <= doc.numPages && !cut && length < limit; n++) {
      const read = await pageItems(await doc.getPage(n), limit - length);
      const text = pageText(read.items);
      pages.push(`--- Page ${n} ---\n${text}`);
      length += text.length;
      cut = read.cut;
    }
  } finally {
    await task.destroy();
  }
  if (!length) throw new Error("no text found");
  const text = pages.join("\n\n");
  return cut || text.length > limit || pages.length < doc.numPages ? `${text.slice(0, limit)}${CUT_NOTE}` : text;
}
