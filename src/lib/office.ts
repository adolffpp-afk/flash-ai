/*
 * Word, Excel and PowerPoint files turned into plain text in the browser, so they can be attached
 * to a chat like a .txt or .csv file. These files are zip archives of XML; only the text is read.
 */

/** Unzips raw "deflate" data: the browser's DecompressionStream, or zlib in tests. */
export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

export const OFFICE_TYPES: Record<string, "docx" | "xlsx" | "pptx"> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** "docx", "xlsx" or "pptx" for an Office file, from its type or its name. */
export function officeKind(name: string, type: string): "docx" | "xlsx" | "pptx" | null {
  return OFFICE_TYPES[type] ?? (name.toLowerCase().match(/\.(docx|xlsx|pptx)$/)?.[1] as "docx" | "xlsx" | "pptx" | undefined) ?? null;
}

// The most text kept from one file, about 50 pages: enough to ask about, small enough to send.
export const MAX_TEXT = 200_000;
const MAX_ENTRY = 40 * 1024 * 1024;

/** The files inside a zip archive whose names pass `want`, as text. */
export async function readZip(bytes: Uint8Array, want: (name: string) => boolean, inflate: Inflate): Promise<Map<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-directory record is in the last 64 KB.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, string>();
  const text = new TextDecoder();
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = text.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (!want(name) || size > MAX_ENTRY) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = bytes.subarray(start, start + packedSize);
    if (method === 0) files.set(name, text.decode(packed));
    else if (method === 8) files.set(name, text.decode(await inflate(packed)));
  }
  return files;
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** A Word document's text, one line per paragraph. */
export function docxText(xml: string): string {
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)]
        .map((m) => (m[2] === "tab" ? "\t" : m[2] ? "\n" : unescape(m[1])))
        .join(""),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A slide's text, one line per paragraph. */
export function slideText(xml: string): string {
  return xml
    .split(/<\/a:p>/)
    .map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unescape(m[1])).join(""))
    .filter((line) => line.trim())
    .join("\n");
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The column number of a cell reference like "C7" (A is 0). */
const column = (ref: string) => [...ref.replace(/\d+$/, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** A worksheet as CSV lines, using the workbook's shared strings. */
export function sheetCsv(xml: string, shared: string[]): string {
  const lines: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = c[1].match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = c[1].match(/\bt="(\w+)"/)?.[1];
      const body = c[2] ?? "";
      const value = body.match(/<v>([^<]*)<\/v>/)?.[1] ?? "";
      const text =
        type === "s"
          ? (shared[Number(value)] ?? "")
          : type === "inlineStr"
            ? [...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => unescape(m[1])).join("")
            : unescape(value);
      const at = ref ? column(ref) : cells.length;
      while (cells.length < at) cells.push("");
      cells[at] = csvCell(text);
    }
    lines.push(cells.join(","));
  }
  while (lines.length && !lines[lines.length - 1].replace(/,/g, "")) lines.pop();
  return lines.join("\n");
}

/** The shared strings of a workbook, in order. */
export function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) => [...si[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => unescape(m[1])).join(""));
}

const byNumber = (a: string, b: string) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);

/** The text of a .docx, .xlsx or .pptx file, cut to MAX_TEXT. Throws if it can't be read. */
export async function officeText(bytes: Uint8Array, kind: "docx" | "xlsx" | "pptx", inflate: Inflate): Promise<string> {
  let text = "";
  if (kind === "docx") {
    const files = await readZip(bytes, (n) => n === "word/document.xml", inflate);
    text = docxText(files.get("word/document.xml") ?? "");
  } else if (kind === "pptx") {
    const files = await readZip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n), inflate);
    text = [...files.keys()]
      .sort(byNumber)
      .map((name, i) => `--- Slide ${i + 1} ---\n${slideText(files.get(name)!)}`)
      .join("\n\n");
  } else {
    const files = await readZip(bytes, (n) => n === "xl/workbook.xml" || n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n), inflate);
    const shared = sharedStrings(files.get("xl/sharedStrings.xml") ?? "");
    const names = [...(files.get("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescape(m[1]));
    text = [...files.keys()]
      .filter((n) => n.startsWith("xl/worksheets/"))
      .sort(byNumber)
      .map((name, i) => `--- Sheet: ${names[i] ?? `Sheet ${i + 1}`} ---\n${sheetCsv(files.get(name)!, shared)}`)
      .join("\n\n");
  }
  if (!text.trim()) throw new Error("no text found");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[The rest of this file was cut to keep it short.]` : text;
}
