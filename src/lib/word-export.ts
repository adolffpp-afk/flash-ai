/*
 * A reply saved as a Word document (.docx), built in the browser from its Markdown: headings,
 * paragraphs, lists, quotes, code, tables, bold, italic and links. No server or library needed.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Style = { bold?: boolean; italic?: boolean; code?: boolean };

function run(text: string, style: Style = {}): string {
  if (!text) return "";
  const props = [style.bold && "<w:b/>", style.italic && "<w:i/>", style.code && '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>']
    .filter(Boolean)
    .join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** Inline Markdown (**bold**, *italic*, `code`, [links](url)) as Word text runs. */
export function inlineRuns(text: string, base: Style = {}): string {
  let out = "";
  // Underscores only count at word edges, so snake_case names stay as they are.
  const re = /(\*\*|__)(.+?)\1|\*(?!\s)(.+?)\*|(?<!\w)_(?!\s)(.+?)_(?!\w)|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += run(text.slice(last, m.index), base);
    if (m[2] !== undefined) out += inlineRuns(m[2], { ...base, bold: true });
    else if (m[3] !== undefined || m[4] !== undefined) out += inlineRuns(m[3] ?? m[4], { ...base, italic: true });
    else if (m[5] !== undefined) out += run(m[5], { ...base, code: true });
    else out += run(`${m[6]} (${m[7]})`, base);
    last = m.index + m[0].length;
  }
  return out + run(text.slice(last), base);
}

const para = (runs: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runs}</w:p>`;

function table(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  const border = '<w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/>';
  const body = rows
    .map(
      (r, i) =>
        `<w:tr>${Array.from({ length: width }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(inlineRuns(r[c] ?? "", { bold: i === 0 }))}</w:tc>`).join("")}</w:tr>`,
    )
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>${body}</w:tbl>`;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The body of a Word document for some Markdown. */
export function markdownToWordXml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    // ``` code blocks keep their lines and spacing, in a fixed-width font.
    if (trimmed.startsWith("```")) {
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) out.push(para(run(lines[i++] || " ", { code: true }), '<w:spacing w:after="0"/>'));
      i++;
      continue;
    }
    // Tables: a header row, a |---| line, then rows.
    if (trimmed.startsWith("|") && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1] ?? "")) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(table(rows), para(""));
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(para(inlineRuns(heading[2].replace(/\s*#+$/, "")), `<w:pStyle w:val="Heading${Math.min(3, heading[1].length)}"/>`));
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(para("", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1"/></w:pBdr>'));
    } else if (trimmed.startsWith(">")) {
      out.push(para(inlineRuns(trimmed.replace(/^>\s?/, ""), { italic: true }), '<w:ind w:left="567"/>'));
    } else {
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const depth = Math.min(4, Math.floor((bullet ?? numbered)![1].replace(/\t/g, "  ").length / 2));
        const marker = bullet ? "•\t" : `${numbered![2]}.\t`;
        const text = bullet ? bullet[2] : numbered![3];
        const checkbox = text.match(/^\[([ xX])\]\s+(.*)$/);
        const runs = run(checkbox ? (checkbox[1] === " " ? "☐\t" : "☑\t") : marker) + inlineRuns(checkbox ? checkbox[2] : text);
        out.push(para(runs, `<w:spacing w:after="60"/><w:ind w:left="${567 + depth * 425}" w:hanging="340"/>`));
      } else {
        // Lines that follow on without a blank line belong to the same paragraph.
        const joined = [trimmed];
        while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|```|>|\||\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i + 1])) joined.push(lines[++i].trim());
        out.push(para(inlineRuns(joined.join(" "))));
      }
    }
    i++;
  }
  return out.join("");
}

const DOCUMENT = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const heading = (n: number, size: number) =>
  `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading(1, 36)}${heading(2, 30)}${heading(3, 26)}</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (data: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A zip archive of the files, stored without compression (Word opens these fine). */
export function zip(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const entry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A .docx file for some Markdown. */
export function wordDocument(markdown: string): Uint8Array {
  return zip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["word/_rels/document.xml.rels", DOC_RELS],
    ["word/document.xml", DOCUMENT(markdownToWordXml(markdown))],
    ["word/styles.xml", STYLES],
  ]);
}

/** A file name from the reply's first line, like "Bakery business plan.docx". */
export function wordFileName(markdown: string): string {
  const first = markdown
    .split("\n")
    .map((l) => l.replace(/^#+\s*|[*_`#>]/g, "").trim())
    .find(Boolean);
  const name = (first ?? "")
    .replace(/[\\/:*?"<>|]+/g, "")
    .slice(0, 60)
    .trim();
  return `${name || "Flash reply"}.docx`;
}
