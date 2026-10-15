import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDeflate, deflateSync } from "node:zlib";
import { pdfTextOnServer } from "../src/lib/server/pdf-server.ts";

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

/** Reads a PDF the way google.ts does, timing it and counting how often a 50 ms timer fired meanwhile. */
async function read(bytes: Uint8Array, deadlineMs = 19_500) {
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 50);
  const start = Date.now();
  try {
    return { result: await pdfTextOnServer(bytes, { maxChars: 100_000, deadline: Date.now() + deadlineMs }), ms: Date.now() - start, ticks };
  } catch (err) {
    return { error: (err as Error).message, ms: Date.now() - start, ticks };
  } finally {
    clearInterval(ticker);
  }
}

test("a PDF's text is read in its own thread", async () => {
  const r = await read(new Uint8Array(readFileSync("test/fixtures/plan.pdf")));
  assert.ok(r.result, r.error);
  assert.equal(r.result.pages, 1);
  assert.equal(r.result.read, 1);
  assert.match(r.result.text, /^--- Page 1 ---\nBakery business plan\nGolden Crumb sells fresh bread in Montréal\./);
});

test("a file that isn't a PDF is refused", async () => {
  const r = await read(new Uint8Array(Buffer.from("not a pdf at all")));
  assert.ok(r.error);
});

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
      const r = await read(bytes);
      assert.equal(r.error, "the PDF used too much memory");
      // Unbounded, the first took 6 s and about 3 GB.
      assert.ok(r.ms < 5000, `${r.ms} ms`);
      assert.ok(peakMb() - before < 600, `peak grew by ${Math.round(peakMb() - before)} MB`);
      // The request's own thread kept running meanwhile.
      assert.ok(r.ticks >= (r.ms / 50) * 0.6, `${r.ticks} ticks in ${r.ms} ms`);
    });
  }
});

test("a PDF that takes too long is stopped at its time, without holding up the server", async () => {
  // 40 KB of "q Q" (save and restore, nothing drawn): small, but slow to work through.
  const slow = onePagePdf(deflateSync(Buffer.concat([Buffer.from("BT /F1 12 Tf 72 712 Td (slow) Tj ET "), Buffer.from("q Q ".repeat(10_000_000))])), "/FlateDecode");
  const r = await read(slow, 1500);
  assert.equal(r.error, "the PDF took too long");
  assert.ok(r.ms >= 1400 && r.ms < 2500, `${r.ms} ms`);
  assert.ok(r.ticks >= 20, `${r.ticks} ticks in ${r.ms} ms`);
});

test("a deadline too close to start isn't tried", async () => {
  const r = await read(new Uint8Array(readFileSync("test/fixtures/plan.pdf")), 500);
  assert.equal(r.error, "no time left to read the PDF");
});
