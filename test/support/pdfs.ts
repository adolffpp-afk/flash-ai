import { deflateSync } from "node:zlib";

// PDFs made for the tests that read them on the server (pdf-server.ts): pages of text, some slow to read.

/** A PDF with one page for each content stream (deflated). */
export function pagesPdf(streams: Buffer[]): Uint8Array {
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${streams.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, stream] of streams.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    const z = deflateSync(stream);
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, Buffer.from("\nendstream")]));
  }
  const parts = [Buffer.from("%PDF-1.4\n")];
  let offset = parts[0].length;
  const xref: number[] = [];
  for (const [i, o] of objects.entries()) {
    xref.push(offset);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(o), Buffer.from("\nendobj\n")]);
    parts.push(part);
    offset += part.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

/** A page with a line of text, then `slow` times "q Q" (save and restore, nothing drawn), which takes about 1 s a million. */
export const page = (text: string, slow = 0) => Buffer.concat([Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET `), Buffer.from("q Q ".repeat(slow))]);
