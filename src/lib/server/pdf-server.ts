import { Worker } from "node:worker_threads";

/*
 * The text of a PDF on Flash's server: a Google Drive file a user picked (see google.ts). It uses
 * pdf.js, which Flash already ships for PDFs attached in the browser, in its build made for Node.
 * The file's bytes come from Google, so they are treated as untrusted: a few hundred KB can unpack
 * into gigabytes while one page is read, in code that never yields. So each PDF is read in its own
 * thread (pdf-worker.ts), and this side stops that thread the moment it runs past its time or holds
 * more than MEMORY_MB, counting the memory pdf.js unpacks into outside the JavaScript heap, which
 * the thread's own heap limit doesn't. At most READERS of these threads run at once, and one user
 * has at most one of them, running or waiting.
 *
 * A stopped thread's memory goes back to the process, but the process doesn't always give it back
 * to the system: glibc keeps each thread's malloc arena for reuse, so reads that overlap can leave
 * the server holding more after each one (MALLOC_ARENA_MAX=2, set where the server starts, keeps
 * that small; see docs/connectors-setup.md). Whatever is held, no read starts while the server holds
 * more than LIMITS.startMaxMb, and any read is stopped once it holds more than LIMITS.rssMaxMb, so
 * PDFs can't take a 2 GB function near its end, which would end every request on it.
 */

/** A PDF's text: pages is how many it has, read how many were read, stopped that its time ran out after those. */
export type PdfResult = { text: string; pages: number; read: number; stopped?: boolean };

/** Pages stop being started this long before the thread is stopped, so a slow file still gives its first pages. */
const PAGES_MARGIN_MS = 1_000;
/** What one read may hold: its heap and what it unpacked (ArrayBuffers), together. */
const MEMORY_MB = 256;
/** How often a running read's memory is looked at. */
const POLL_MS = 20;
/** How many PDFs this server reads at once. */
const READERS = 2;
/** How much the whole process may grow while a PDF is read, when its thread doesn't say what it holds: every reader's share, and room for the rest. */
const GROWTH_MB = READERS * MEMORY_MB + 256;
/** How long a reading thread may go without saying what it holds before the process's growth counts against it instead. */
const QUIET_MS = 250;
/** A wait for a turn longer than this means other PDFs held the readers. */
const BUSY_WAIT_MS = 1_000;
const MB = 1024 * 1024;

/**
 * The limits that depend on time and on the server's memory, for a 2 GB function (Vercel's
 * default): the longest a PDF is read for, waiting for a turn included; the process's memory above
 * which no read starts; and the memory at which any read is stopped. A server of about 300 MB that
 * read hostile PDFs holds about 900 MB with MALLOC_ARENA_MAX=2, most of it free for the next reads,
 * so reads still start there; without it, it holds about 1.2 GB, and PDFs wait for a fresh server.
 * Only tests change them.
 */
export const LIMITS = { readMs: 8_000, startMaxMb: 1_000, rssMaxMb: 1_300 };

/**
 * A PDF that wasn't read for a reason that has nothing to do with the file: other PDFs held every
 * reader (or this user's other PDF is being read), or the server holds too much memory to read one.
 */
export class PdfNotNow extends Error {
  readonly why: "busy" | "memory";
  constructor(why: "busy" | "memory", message: string) {
    super(message);
    this.name = "PdfNotNow";
    this.why = why;
  }
}

const rss = () => process.memoryUsage.rss();

const TOO_LONG = "the PDF took too long";

let running = 0;
const waiting: (() => void)[] = [];
/** Who is reading a PDF now or waiting for a turn: one at a time each. */
const reading = new Set<string>();

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
 * more than LIMITS.readMs; when time runs out, the pages read by then (stopped). `user` is who asked:
 * another PDF of theirs while one is read or waits is refused at once. Throws PdfNotNow when the
 * server can't read a PDF now, and an Error when the file isn't a PDF pdf.js can open, or reading
 * it ran out of memory, or out of time before a page was read.
 */
export async function pdfTextOnServer(bytes: Uint8Array, { maxChars, deadline, user }: { maxChars: number; deadline: number; user: string }): Promise<PdfResult> {
  const asked = Date.now();
  const until = Math.min(deadline, asked + LIMITS.readMs);
  if (reading.has(user)) throw new PdfNotNow("busy", "this user's other PDF is being read");
  if (rss() > LIMITS.startMaxMb * MB) throw new PdfNotNow("memory", "the server is low on memory");
  reading.add(user);
  try {
    if (!(await turn(until))) throw new PdfNotNow("busy", "no turn to read the PDF in time");
    // The turn is given back once the thread is gone, not when its answer is: a stopped thread's
    // memory is freed as it ends, so no more than READERS threads ever hold memory at once.
    let ended = Promise.resolve();
    try {
      const waited = Date.now() - asked > BUSY_WAIT_MS;
      const late = (message: string) => (waited ? new PdfNotNow("busy", message) : new Error(message));
      // Memory may have grown while it waited.
      if (rss() > LIMITS.startMaxMb * MB) throw new PdfNotNow("memory", "the server is low on memory");
      if (until - Date.now() < PAGES_MARGIN_MS) throw late("no time left to read the PDF");
      const reader = readInThread(bytes, maxChars, until);
      ended = reader.ended;
      let result: PdfResult;
      try {
        result = await reader.result;
      } catch (err) {
        // Out of time before a page was read: after a long wait for a turn, the wait took the time.
        throw !(err instanceof PdfNotNow) && (err as Error).message === TOO_LONG ? late(TOO_LONG) : err;
      }
      // Opening the file took all the time there was for pages.
      if (result.read === 0 && result.pages > 0) throw late(TOO_LONG);
      return result;
    } finally {
      void ended.then(turnDone);
    }
  } finally {
    reading.delete(user);
  }
}

/** How long a stopped thread may take to end before its turn is given back anyway. */
const END_MS = 1_000;

/** Reads a PDF in a thread of its own: its result, and when the thread has ended (or END_MS after it was stopped). */
function readInThread(bytes: Uint8Array, maxChars: number, until: number): { result: Promise<PdfResult>; ended: Promise<void> } {
  let ended!: Promise<void>;
  const result = new Promise<PdfResult>((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), {
      workerData: { bytes, maxChars, pagesUntil: until - PAGES_MARGIN_MS },
      resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB, maxYoungGenerationSizeMb: 32 },
      // What pdf.js prints can quote the file: it is dropped, never logged.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    // The pages read so far, sent by the thread one by one, so a read stopped at its time keeps them.
    const parts: string[] = [];
    let pages = 0;
    let finished = false;
    const exited = new Promise<void>((done) => worker.once("exit", () => done()));
    const finish = (outcome: { result: PdfResult } | { error: Error }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopWatching();
      void worker.terminate();
      ended = Promise.race([exited, new Promise<void>((done) => setTimeout(done, END_MS).unref())]);
      if ("result" in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };
    const timer = setTimeout(
      () => finish(parts.length ? { result: { text: parts.join("\n\n"), pages, read: parts.length, stopped: true } } : { error: new Error(TOO_LONG) }),
      until - Date.now(),
    );
    const stopWatching = watchMemory(worker, (server) => finish({ error: server ? new PdfNotNow("memory", "the server is low on memory") : new Error("the PDF used too much memory") }));
    worker.on("message", (message: { page?: string; text?: string; pages?: number; read?: number; failed?: boolean }) => {
      if (typeof message.page === "string") {
        parts.push(message.page);
        pages = Number(message.pages);
        return;
      }
      if (message.failed || typeof message.text !== "string") finish({ error: new Error("pdf.js couldn't open the PDF") });
      else finish({ result: { text: message.text, pages: Number(message.pages), read: Number(message.read) } });
    });
    worker.once("error", () => finish({ error: new Error("the PDF's thread failed") }));
    worker.once("exit", () => finish({ error: new Error("the PDF's thread stopped") }));
  });
  return { result, ended: result.then(() => ended, () => ended) };
}

type HeapInfo = { used_heap_size: number; external_memory?: number };

/**
 * Looks at a reading thread's memory every POLL_MS and calls over(false) once its own heap and its
 * ArrayBuffers together pass MEMORY_MB (Node answers that between the thread's steps): a read is
 * judged by what it holds itself, not by what other reads hold or left in the process. Only when
 * the thread can't say (Node before 22.16) or hasn't answered for QUIET_MS (too busy to) does the
 * process's growth since the read began count against it. And whoever holds it, once the process
 * holds more than LIMITS.rssMaxMb, over(true) stops the read. Returns what ends the watch.
 */
function watchMemory(worker: Worker, over: (server: boolean) => void): () => void {
  const stats = (worker as Worker & { getHeapStatistics?: () => Promise<HeapInfo> }).getHeapStatistics?.bind(worker);
  const limit = MEMORY_MB * MB;
  const growthLimit = stats ? GROWTH_MB * MB : limit;
  const base = rss();
  let asking = false;
  // Since when the running thread hasn't said what it holds. Time this side's own thread was held
  // up doesn't count: no answer could have come in then.
  let online = false;
  let quietSince = Date.now();
  let last = Date.now();
  worker.once("online", () => {
    online = true;
    quietSince = Date.now();
  });
  const tick = setInterval(() => {
    const at = Date.now();
    if (at - last > 2 * POLL_MS) quietSince = Math.min(at, quietSince + (at - last - POLL_MS));
    last = at;
    const now = rss();
    if (now > LIMITS.rssMaxMb * MB) return over(true);
    if ((!stats || (online && at - quietSince > QUIET_MS)) && now - base > growthLimit) return over(false);
    if (!stats || asking) return;
    asking = true;
    stats().then(
      (h) => {
        asking = false;
        quietSince = Date.now();
        if (h.used_heap_size + (h.external_memory ?? 0) > limit) over(false);
      },
      () => (asking = false), // not running yet, or ended
    );
  }, POLL_MS);
  return () => clearInterval(tick);
}
