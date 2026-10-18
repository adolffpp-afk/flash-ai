/*
 * The text of a PDF, read in the browser with pdf.js. Small PDFs are sent whole so Flash sees
 * their pictures and layout too; bigger ones (up to MAX_PDF_MB) send only their text.
 */
import { CUT_NOTE, MAX_TEXT } from "./office.ts";

export const MAX_PDF_MB = 30;

type TextItem = { str?: string; hasEOL?: boolean };
type PdfLib = {
  getDocument: (src: { data: Uint8Array }) => {
    promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: object[] }> }> }>;
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
 * A PDF's text, page by page, cut to `limit` characters (a chat's MAX_TEXT unless given), with
 * CUT_NOTE after a cut. Pages past the limit aren't read. Throws when it has no text (a scan).
 */
export async function pdfText(bytes: Uint8Array, lib: PdfLib, limit = MAX_TEXT): Promise<string> {
  const task = lib.getDocument({ data: bytes });
  const doc = await task.promise;
  const pages: string[] = [];
  let length = 0;
  try {
    for (let n = 1; n <= doc.numPages && length < limit; n++) {
      const text = pageText((await (await doc.getPage(n)).getTextContent()).items);
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
