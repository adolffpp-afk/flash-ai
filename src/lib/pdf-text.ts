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
 * `room` characters that aren't spaces or line breaks. pageText keeps those whatever comes after
 * them, so the page's text is then past `room` too, and pdf.js is told to stop: the rest of the page
 * isn't read.
 */
async function pageItems(page: PdfPage, room: number): Promise<object[]> {
  const reader = page.streamTextContent().getReader();
  const items: object[] = [];
  let chars = 0;
  try {
    while (chars <= room) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        items.push(item);
        chars += ((item as TextItem).str ?? "").replace(/\s+/g, "").length;
      }
    }
    return items;
  } finally {
    // pdf.js wants an Error as the reason: without one, it goes on sending into a closed stream. Named
    // AbortException, its worker takes it as a stop and says nothing, as it does for its own; any other
    // name logs a warning in the browser's console whenever the stop comes before the page's end.
    reader.cancel(Object.assign(new Error("enough text"), { name: "AbortException" })).catch(() => {});
  }
}

/**
 * A PDF's text, page by page, cut to `limit` characters (a chat's MAX_TEXT unless given), with
 * CUT_NOTE after a cut: the same text as reading each page whole and cutting it after. Once its
 * characters other than spaces and line breaks are past the limit, no more is read: not the rest of
 * that page, nor the pages after it. That bounds the text, not all the work: pdf.js unpacks a
 * page's content whole before it sends any of its text, and a page whose content is mostly not
 * text takes as long as that content does. Throws when it has no text (a scan).
 */
export async function pdfText(bytes: Uint8Array, lib: PdfLib, limit = MAX_TEXT): Promise<string> {
  const task = lib.getDocument({ data: bytes });
  const doc = await task.promise;
  const pages: string[] = [];
  let length = 0;
  try {
    for (let n = 1; n <= doc.numPages && length < limit; n++) {
      const text = pageText(await pageItems(await doc.getPage(n), limit - length));
      pages.push(`--- Page ${n} ---\n${text}`);
      length += text.length;
    }
  } finally {
    await task.destroy();
  }
  if (!length) throw new Error("no text found");
  const text = pages.join("\n\n");
  return text.length > limit || pages.length < doc.numPages ? `${text.slice(0, limit)}${CUT_NOTE}` : text;
}
