import { Worker } from "node:worker_threads";

/*
 * The text of a PDF on Flash's server: a Google Drive file a user picked (see google.ts). It uses
 * pdf.js, which Flash already ships for PDFs attached in the browser, in its build made for Node.
 * The file's bytes come from Google, so they are treated as untrusted: a few hundred KB can unpack
 * into gigabytes while one page is read, in code that never yields. So each PDF is read in its own
 * thread (pdf-worker.ts), and this side stops that thread the moment it runs past its time or holds
 * more than MEMORY_MB, counting the memory pdf.js unpacks into outside the JavaScript heap, which
 * the thread's own heap limit doesn't. At most READERS of these threads run at once, so the server
 * never holds much more than READERS times that for PDFs.
 */

/** The longest a PDF is read for, waiting for a turn included. */
const READ_MS = 8_000;
/** Pages stop being started this long before the thread is stopped, so a slow file still gives its first pages. */
const PAGES_MARGIN_MS = 1_000;
/** What one read may hold: its heap and what it unpacked (ArrayBuffers), together. */
const MEMORY_MB = 256;
/** How often a running read's memory is looked at. */
const POLL_MS = 20;
/** How many PDFs this server reads at once. */
const READERS = 2;
/** How much the whole process may grow while a PDF is read: every reader's share, and room for the rest. */
const GROWTH_MB = READERS * MEMORY_MB + 256;

type HeapInfo = { used_heap_size: number; external_memory?: number };
type Result = { text: string; pages: number; read: number };

let running = 0;
const waiting: (() => void)[] = [];

/** A turn to read, before `until` (Date.now() ms); false when none came in time. */
function turn(until: number): Promise<boolean> {
  if (running < READERS) {
    running++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const go = () => {
      clearTimeout(timer);
      running++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(go);
      if (at >= 0) waiting.splice(at, 1);
      resolve(false);
    }, Math.max(0, until - Date.now()));
    waiting.push(go);
  });
}

function turnDone() {
  running--;
  waiting.shift()?.();
}

/**
 * A PDF's text, page by page, until about maxChars or the deadline (Date.now() ms), and never for
 * more than READ_MS. pages is how many it has, read how many were read. Throws when the file isn't
 * a PDF pdf.js can open, or when reading it ran out of time or memory.
 */
export async function pdfTextOnServer(bytes: Uint8Array, { maxChars, deadline }: { maxChars: number; deadline: number }): Promise<Result> {
  const until = Math.min(deadline, Date.now() + READ_MS);
  if (!(await turn(until))) throw new Error("no turn to read the PDF in time");
  try {
    if (until - Date.now() < PAGES_MARGIN_MS) throw new Error("no time left to read the PDF");
    return await readInThread(bytes, maxChars, until);
  } finally {
    turnDone();
  }
}

function readInThread(bytes: Uint8Array, maxChars: number, until: number): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), {
      workerData: { bytes, maxChars, pagesUntil: until - PAGES_MARGIN_MS },
      resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB, maxYoungGenerationSizeMb: 32 },
      // What pdf.js prints can quote the file: it is dropped, never logged.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let finished = false;
    const finish = (outcome: { result: Result } | { error: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopWatching();
      void worker.terminate();
      if ("result" in outcome) resolve(outcome.result);
      else reject(new Error(outcome.error));
    };
    const timer = setTimeout(() => finish({ error: "the PDF took too long" }), until - Date.now());
    const stopWatching = watchMemory(worker, () => finish({ error: "the PDF used too much memory" }));
    worker.once("message", (message: Partial<Result> & { failed?: boolean }) => {
      if (message.failed || typeof message.text !== "string") finish({ error: "pdf.js couldn't open the PDF" });
      else finish({ result: { text: message.text, pages: Number(message.pages), read: Number(message.read) } });
    });
    worker.once("error", () => finish({ error: "the PDF's thread failed" }));
    worker.once("exit", () => finish({ error: "the PDF's thread stopped" }));
  });
}

/**
 * Looks at a reading thread's memory every POLL_MS and calls over() once its heap and its
 * ArrayBuffers together pass MEMORY_MB (Node answers that between the thread's steps; before 22.16
 * it can't, and the process's own growth is counted against MEMORY_MB instead). The process's
 * growth since the read began is also checked on every look, from this side, so a thread too busy
 * to answer is stopped too. Returns what ends the watch.
 */
function watchMemory(worker: Worker, over: () => void): () => void {
  const stats = (worker as Worker & { getHeapStatistics?: () => Promise<HeapInfo> }).getHeapStatistics?.bind(worker);
  const limit = MEMORY_MB * 1024 * 1024;
  const growthLimit = stats ? GROWTH_MB * 1024 * 1024 : limit;
  const base = process.memoryUsage.rss();
  let asking = false;
  const tick = setInterval(() => {
    if (process.memoryUsage.rss() - base > growthLimit) return over();
    if (!stats || asking) return;
    asking = true;
    stats().then(
      (h) => {
        asking = false;
        if (h.used_heap_size + (h.external_memory ?? 0) > limit) over();
      },
      () => (asking = false), // not running yet, or ended
    );
  }, POLL_MS);
  return () => clearInterval(tick);
}
