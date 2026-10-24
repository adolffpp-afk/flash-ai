/*
 * pdf.js in the browser, loaded the first time a PDF is read or shown. Its legacy build: the modern
 * one needs JavaScript newer than many browsers have (a PDF with an owner password fails without
 * Map.prototype.getOrInsertComputed, for one). What it reads and draws is the same.
 */
export async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
  }
  return pdfjs;
}
