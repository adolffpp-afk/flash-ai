/*
 * The tables in a reply saved as an Excel workbook (.xlsx), one sheet per table, built in the
 * browser. Plain numbers, dollar amounts and percentages become real numbers, so they add up.
 */
import { zip } from "./word-export.ts";

export type Table = { name: string; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim().replace(/\*\*|__|`/g, ""));

/** The Markdown tables in a reply, each named after the heading above it. */
export function tablesIn(markdown: string): Table[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const tables: Table[] = [];
  let heading = "";
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) heading = h[1].replace(/[*_`#]/g, "").trim();
    if (line.startsWith("|") && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1] ?? "")) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      i--;
      tables.push({ name: heading, rows });
    }
  }
  return tables;
}

/** A cell's value: a number with its format, or text. */
export function cellValue(text: string): { number: number; style: 0 | 1 | 2 } | { text: string } {
  const t = text.trim();
  const money = t.match(/^(-)?\$\s?(-)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/);
  if (money) {
    const value = Number((money[3] + (money[4] ?? "")).replace(/,/g, ""));
    return { number: money[1] || money[2] ? -value : value, style: 1 };
  }
  const percent = t.match(/^(-?\d+(?:\.\d+)?)\s?%$/);
  if (percent) return { number: Number(percent[1]) / 100, style: 2 };
  if (/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t) && !/^0\d/.test(t)) return { number: Number(t.replace(/,/g, "")), style: 0 };
  return { text: t };
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters aren't allowed in the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const columnName = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : columnName(Math.floor(n / 26) - 1) + String.fromCharCode(65 + (n % 26)));

function sheetXml(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array.from({ length: width }, (_, c) => Math.min(60, Math.max(8, ...rows.map((r) => (r[c] ?? "").length + 2))));
  const body = rows
    .map((row, r) => {
      const xs = row.map((value, c) => {
        const ref = `${columnName(c)}${r + 1}`;
        const v = r === 0 ? { text: value } : cellValue(value);
        if ("number" in v) return `<c r="${ref}"${v.style ? ` s="${v.style}"` : ""}><v>${v.number}</v></c>`;
        return v.text ? `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="3"' : ""}><is><t xml:space="preserve">${esc(v.text)}</t></is></c>` : "";
      });
      return `<row r="${r + 1}">${xs.join("")}</row>`;
    })
    .join("");
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

/** Sheet names: from the headings, at most 31 characters, no characters Excel refuses, no repeats. */
export function sheetNames(tables: Table[]): string[] {
  const used = new Set<string>();
  return tables.map((t, i) => {
    const base = (t.name.replace(/[[\]:*?/\\']/g, "").trim() || `Table ${i + 1}`).slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - ` (${n})`.length)} (${n})`;
    used.add(name.toLowerCase());
    return name;
  });
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** An .xlsx workbook with one sheet per table. */
export function excelWorkbook(tables: Table[]): Uint8Array {
  const names = sheetNames(tables);
  const sheets = names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const rels = names
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("");
  const overrides = names
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("");
  return zip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ["xl/styles.xml", STYLES],
    ...tables.map((t, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t.rows)]),
  ]);
}
