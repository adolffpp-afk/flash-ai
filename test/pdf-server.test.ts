import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createDeflate, deflateSync } from "node:zlib";
import { LIMITS, PdfNotNow, pdfTextOnServer } from "../src/lib/server/pdf-server.ts";
import { page, pagesPdf } from "./support/pdfs.ts";

// PDFs from Google Drive are read on the server in a thread of their own, which is stopped when it
// runs past its time or memory: a few KB can unpack into gigabytes inside one page.

/** A one-page PDF whose content stream is `stream`, with these filters. */
function onePagePdf(stream: Buffer, filter: string): Uint8Array {
  const objects: (string | null)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  let offset = parts[0].length;
  const xref: number[] = [];
  objects.forEach((o, i) => {
    xref.push(offset);
    const body = o ?? `<< /Length ${stream.length} /Filter ${filter} >>\nstream\n`;
    const part = o === null ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${body}`), stream, Buffer.from("\nendstream\nendobj\n")]) : Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(part);
    offset += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

/** prefix, then `count` copies of `byte`, then suffix, deflated without ever holding them whole. */
async function deflated(prefix: string, byte: number, count: number, suffix: string): Promise<Buffer> {
  const z = createDeflate({ level: 6 });
  const chunks: Buffer[] = [];
  z.on("data", (c: Buffer) => chunks.push(c));
  const ended = new Promise((r) => z.on("end", r));
  z.write(Buffer.from(prefix));
  const block = Buffer.alloc(1 << 20, byte);
  for (let left = count; left > 0; left -= block.length) {
    if (!z.write(left >= block.length ? block : block.subarray(0, left))) await new Promise((r) => z.once("drain", r));
  }
  z.end(Buffer.from(suffix));
  await ended;
  return Buffer.concat(chunks);
}

/** This process's peak memory so far (VmHWM), in MB. */
const peakMb = () => Number(/VmHWM:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))![1]) / 1024;

/** Reads a PDF the way google.ts does, for `user`, timing it and counting how often a 50 ms timer fired meanwhile. */
async function read(bytes: Uint8Array, deadlineMs = 19_500, user = "someone") {
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 50);
  const start = Date.now();
  try {
    return { result: await pdfTextOnServer(bytes, { maxChars: 100_000, deadline: Date.now() + deadlineMs, user }), ms: Date.now() - start, ticks };
  } catch (err) {
    return { error: (err as Error).message, notNow: err instanceof PdfNotNow ? err.why : undefined, ms: Date.now() - start, ticks };
  } finally {
    clearInterval(ticker);
  }
}

/** Runs fn with these limits, then puts the usual ones back. */
async function withLimits<T>(limits: Partial<typeof LIMITS>, fn: () => Promise<T>): Promise<T> {
  const usual = { ...LIMITS };
  Object.assign(LIMITS, limits);
  try {
    return await fn();
  } finally {
    Object.assign(LIMITS, usual);
  }
}

const plan = () => new Uint8Array(readFileSync("test/fixtures/plan.pdf"));

test("a PDF's text is read in its own thread", async () => {
  const r = await read(plan());
  assert.ok(r.result, r.error);
  assert.equal(r.result.pages, 1);
  assert.equal(r.result.read, 1);
  assert.match(r.result.text, /^--- Page 1 ---\nBakery business plan\nGolden Crumb sells fresh bread in Montréal\./);
});

test("a file that isn't a PDF is refused", async () => {
  const r = await read(new Uint8Array(Buffer.from("not a pdf at all")));
  assert.ok(r.error);
});

test("a PDF that takes too long is stopped at its time, without holding up the server", async () => {
  // 40 KB of "q Q" (save and restore, nothing drawn): small, but slow to work through.
  const slow = onePagePdf(deflateSync(Buffer.concat([Buffer.from("BT /F1 12 Tf 72 712 Td (slow) Tj ET "), Buffer.from("q Q ".repeat(10_000_000))])), "/FlateDecode");
  // Pages are started until a second before the time is up, so this one starts and is stopped at 2.5 s.
  const r = await read(slow, 2500);
  assert.equal(r.error, "the PDF took too long");
  assert.equal(r.notNow, undefined, "it had the time to itself: the file is too slow");
  assert.ok(r.ms >= 2400 && r.ms < 3500, `${r.ms} ms`);
  assert.ok(r.ticks >= 20, `${r.ticks} ticks in ${r.ms} ms`);
});

test("a deadline too close to start isn't tried", async () => {
  const r = await read(plan(), 500);
  assert.equal(r.error, "no time left to read the PDF");
  assert.equal(r.notNow, undefined, "nothing else was being read: the time was the reply's own");
});

test("when its time runs out, the pages read by then are kept, and said to be all that was read", async () => {
  // Page 1 reads at once; page 2 would take far longer than the time there is.
  const r = await read(pagesPdf([page("The first page"), page("Never read", 10_000_000)]), 4000);
  assert.ok(r.result, r.error);
  assert.deepEqual(r.result, { text: "--- Page 1 ---\nThe first page", pages: 2, read: 1, stopped: true });
  assert.ok(r.ms >= 3900 && r.ms < 5000, `${r.ms} ms`);
});

test("one user reads one PDF at a time: another of theirs is refused at once, and someone else's is read meanwhile", async () => {
  const slow = pagesPdf([page("slow", 10_000_000)]);
  const first = read(slow, 3000, "user-a");
  await new Promise((r) => setTimeout(r, 100));
  const second = await read(slow, 3000, "user-a");
  assert.equal(second.notNow, "busy");
  assert.ok(second.ms < 100, `${second.ms} ms`);
  // The other reader is free for another user: without the rule, user A's second PDF would hold it.
  const other = await read(plan(), 3000, "user-b");
  assert.ok(other.result, other.error);
  assert.equal((await first).error, "the PDF took too long");
  // Once theirs is done, user A can read again.
  assert.ok((await read(plan(), 3000, "user-a")).result);
});

test("a PDF that waited for a turn until too late was refused because other PDFs held the readers, not for the file", async () => {
  const slow = pagesPdf([page("slow", 10_000_000)]);
  const holding = [read(slow, 4000, "user-a"), read(slow, 4000, "user-b")];
  await new Promise((r) => setTimeout(r, 100));
  const late = await read(plan(), 2500, "user-c");
  assert.equal(late.notNow, "busy", late.error);
  await Promise.all(holding);
  // A turn that came after a long wait, too late for a page: the wait took its time, not the file.
  const shorter = [read(slow, 2000, "user-a"), read(slow, 2000, "user-b")];
  await new Promise((r) => setTimeout(r, 100));
  const after = await read(slow, 3800, "user-c");
  assert.equal(after.notNow, "busy", after.error);
  assert.ok(after.ms >= 3500, `${after.ms} ms: it got a turn and read until its time`);
  await Promise.all(shorter);
});

test("no PDF is started while the server holds too much memory, and a read stops once it does, whoever holds it", async () => {
  // Refused before a thread is started.
  const refused = await withLimits({ startMaxMb: 1 }, () => read(plan()));
  assert.equal(refused.notNow, "memory", refused.error);
  assert.ok(refused.ms < 100, `${refused.ms} ms`);
  // A read under way is stopped as soon as the server holds more than the ceiling, though it holds little itself.
  const stopped = await withLimits({ startMaxMb: 1e6, rssMaxMb: 1 }, () => read(pagesPdf([page("slow", 10_000_000)])));
  assert.equal(stopped.notNow, "memory", stopped.error);
  assert.ok(stopped.ms < 1000, `${stopped.ms} ms`);
  // Below them, PDFs are read as usual.
  assert.ok((await read(plan())).result);
});

test("/admin tells whether MALLOC_ARENA_MAX was set as the server started, which is when glibc reads it, not later in code", () => {
  const show = `import { startEnv } from ${JSON.stringify(new URL("../src/lib/server/start-env.ts", import.meta.url).href)}; console.log(JSON.stringify(startEnv("MALLOC_ARENA_MAX")));`;
  const run = (env: Record<string, string>, code: string) =>
    execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }).trim();
  assert.equal(run({ MALLOC_ARENA_MAX: "2" }, show), '"2"');
  assert.equal(run({}, show), "null");
  assert.equal(run({}, `process.env.MALLOC_ARENA_MAX = "2"; ${show}`), "null");
});

// The tests from here on leave the process holding memory the threads gave back (see pdf-server.ts),
// so the ones before them don't depend on it.
test("a PDF that unpacks into gigabytes is stopped at its memory, quickly, and the server's own memory stays low", async (t) => {
  // 300 MB in one string (306 KB on disk), 400 MB of spaces, and 400 MB behind two Flate layers (a few KB).
  const bombs: [string, Uint8Array][] = [
    ["one 300 MB string", onePagePdf(await deflated("BT /F1 12 Tf 72 712 Td (", 0x41, 300 << 20, ") Tj ET"), "/FlateDecode")],
    ["400 MB of spaces", onePagePdf(await deflated("BT /F1 12 Tf 72 712 Td (hi) Tj ", 0x20, 400 << 20, " ET"), "/FlateDecode")],
    ["Flate in Flate", onePagePdf(deflateSync(await deflated("BT /F1 12 Tf 72 712 Td (hi) Tj ", 0x20, 400 << 20, " ET")), "[/FlateDecode /FlateDecode]")],
  ];
  for (const [name, bytes] of bombs) {
    await t.test(`${name} (${Math.round(bytes.length / 1024)} KB)`, async () => {
      const before = peakMb();
      // Each is stopped by what it holds itself, whatever the server's own ceilings (tested below).
      const r = await withLimits({ startMaxMb: 1e6, rssMaxMb: 1e6 }, () => read(bytes));
      assert.equal(r.error, "the PDF used too much memory");
      // Unbounded, the first took 6 s and about 3 GB.
      assert.ok(r.ms < 5000, `${r.ms} ms`);
      assert.ok(peakMb() - before < 600, `peak grew by ${Math.round(peakMb() - before)} MB`);
      // The request's own thread kept running meanwhile.
      assert.ok(r.ticks >= (r.ms / 50) * 0.6, `${r.ticks} ticks in ${r.ms} ms`);
    });
  }
});

test("a read is judged by the memory it holds itself, not by what the rest of the server holds", async () => {
  // About 2 s of honest pages, while the rest of the process grows by 900 MB (as other users' PDFs
  // can leave it): the read holds little itself, so it is read in full.
  const pages = pagesPdf([page("Page one", 600_000), page("Page two", 600_000), page("Page three", 600_000)]);
  const r = await withLimits({ startMaxMb: 1e6, rssMaxMb: 1e6 }, async () => {
    const reading = read(pages);
    await new Promise((res) => setTimeout(res, 300));
    const elsewhere = Buffer.alloc(900 * 1048576, 1);
    const out = await reading;
    assert.equal(elsewhere[elsewhere.length - 1], 1);
    return out;
  });
  assert.ok(r.result, r.error);
  assert.deepEqual([r.result.pages, r.result.read, r.result.stopped], [3, 3, undefined]);
  assert.match(r.result.text, /Page three$/);
});
