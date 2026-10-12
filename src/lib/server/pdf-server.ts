import { pageText } from "../pdf-text.ts";

/*
 * The text of a PDF on Flash's server: a Google Drive file a user picked (see google.ts). It uses
 * pdf.js, which Flash already ships for PDFs attached in the browser, in its build made for Node, in
 * this same process: its worker runs here (globalThis.pdfjsWorker), so no thread is started and
 * nothing is fetched, no fonts are loaded, and only each page's text is read. The file's bytes come
 * from Google, so they are treated as untrusted: reading stops at a character count and a time.
 */

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loading: Promise<PdfJs> | null = null;

/** pdf.js, loaded once, with its worker in this thread. */
function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/**
 * A PDF's text, page by page, until about maxChars or the deadline (Date.now() ms). pages is how
 * many it has, read how many were read. Throws when the file isn't a PDF pdf.js can open.
 */
export async function pdfTextOnServer(bytes: Uint8Array, { maxChars, deadline }: { maxChars: number; deadline: number }): Promise<{ text: string; pages: number; read: number }> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  try {
    const doc = await task.promise;
    const parts: string[] = [];
    let length = 0;
    let read = 0;
    for (let n = 1; n <= doc.numPages && length < maxChars && Date.now() < deadline; n++) {
      const text = pageText((await (await doc.getPage(n)).getTextContent()).items);
      parts.push(`--- Page ${n} ---\n${text}`);
      length += text.length;
      read = n;
    }
    return { text: parts.join("\n\n"), pages: doc.numPages, read };
  } finally {
    await task.destroy();
  }
}
