import { parentPort, workerData } from "node:worker_threads";
import { pageText } from "../pdf-text.ts";

/*
 * Reads a PDF's text in its own thread for pdf-server.ts, which stops this thread when it runs past
 * its time or memory. pdf.js's own worker runs here too (globalThis.pdfjsWorker), so nothing more is
 * started and nothing is fetched, no fonts are loaded, and only each page's text is read (this
 * version of pdf.js never compiles code from a file).
 */

type Job = { bytes: Uint8Array; maxChars: number; pagesUntil: number };

const { bytes, maxChars, pagesUntil } = workerData as Job;
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = lib.getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
try {
  const doc = await task.promise;
  const parts: string[] = [];
  let length = 0;
  let read = 0;
  for (let n = 1; n <= doc.numPages && length < maxChars && Date.now() < pagesUntil; n++) {
    const text = pageText((await (await doc.getPage(n)).getTextContent()).items);
    parts.push(`--- Page ${n} ---\n${text}`);
    length += text.length;
    read = n;
  }
  parentPort!.postMessage({ text: parts.join("\n\n"), pages: doc.numPages, read });
} catch {
  parentPort!.postMessage({ failed: true });
} finally {
  await task.destroy();
}
