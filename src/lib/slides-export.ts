/*
 * A reply saved as a PowerPoint deck (.pptx), built in the browser: a title slide, then one slide
 * per heading with its points, paragraphs and tables. Long sections carry on to a next slide.
 */
import { zip } from "./word-export.ts";

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type Line = { runs: Run[]; level: number; bullet: string | null; code?: boolean };
export type Slide = { title: string; lines: Line[]; table: string[][] | null };

// How much fits on one 16:9 slide at the sizes used below.
const MAX_LINES = 9;
const CHARS_PER_LINE = 80;
const MAX_ROWS = 8;

/** Inline Markdown (**bold**, *italic*, `code`, [links](url)) as text runs. */
export function runsOf(text: string, base: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  const re = /(\*\*|__)(.+?)\1|\*(?!\s)(.+?)\*|(?<!\w)_(?!\s)(.+?)_(?!\w)|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  const plain = (t: string) => t && out.push({ ...base, text: t });
  for (const m of text.matchAll(re)) {
    plain(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(...runsOf(m[2], { ...base, bold: true }));
    else if (m[3] !== undefined || m[4] !== undefined) out.push(...runsOf(m[3] ?? m[4], { ...base, italic: true }));
    else if (m[5] !== undefined) out.push({ ...base, text: m[5], code: true });
    else plain(`${m[6]} (${m[7]})`);
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}

const textOf = (runs: Run[]) => runs.map((r) => r.text).join("");
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const lineCost = (l: Line) => Math.max(1, Math.ceil(textOf(l.runs).length / (CHARS_PER_LINE - l.level * 6)));

/** The deck's title and slides for some Markdown. */
export function slidesOf(markdown: string, fallbackTitle: string): { title: string; slides: Slide[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const slides: Slide[] = [];
  let title = "";
  let current: Slide | null = null;
  const open = (t: string) => {
    current = { title: t, lines: [], table: null };
    slides.push(current);
    return current;
  };
  const slide = (): Slide => {
    const s = current as Slide | null;
    // A table gets a slide to itself, so what follows it starts a new one.
    if (!s || s.table) return open(s ? `${s.title} (continued)` : title || fallbackTitle);
    return s;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue;
    if (trimmed.startsWith("```")) {
      const s = slide();
      while (++i < lines.length && !lines[i].trim().startsWith("```")) s.lines.push({ runs: [{ text: lines[i] || " ", code: true }], level: 0, bullet: null, code: true });
      continue;
    }
    if (trimmed.startsWith("|") && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1] ?? "")) {
      const rows = [cells(line).map((c) => textOf(runsOf(c)))];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]).map((c) => textOf(runsOf(c))));
      i--;
      const s = current as Slide | null;
      // A table joins its heading's slide when that slide has little else on it.
      const target = s && !s.table && s.lines.length <= 2 ? s : open(s?.title ?? (title || fallbackTitle));
      target.table = rows;
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const text = textOf(runsOf(heading[2].replace(/\s*#+$/, "")));
      // The first heading, before anything else, names the deck.
      if (!title && !slides.length) title = text;
      else if (heading[1].length <= 3) open(text);
      else slide().lines.push({ runs: [{ text, bold: true }], level: 0, bullet: null });
      continue;
    }
    if (trimmed.startsWith(">")) {
      slide().lines.push({ runs: runsOf(trimmed.replace(/^>\s?/, ""), { italic: true }), level: 0, bullet: null });
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const level = Math.min(2, Math.floor((bullet ?? numbered)![1].replace(/\t/g, "  ").length / 2));
      const text = bullet ? bullet[2] : numbered![3];
      const box = text.match(/^\[([ xX])\]\s+(.*)$/);
      slide().lines.push({ runs: runsOf(box ? box[2] : text), level, bullet: box ? (box[1] === " " ? "☐" : "☑") : bullet ? "•" : `${numbered![2]}.` });
      continue;
    }
    const joined = [trimmed];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|```|>|\||\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i + 1])) joined.push(lines[++i].trim());
    slide().lines.push({ runs: runsOf(joined.join(" ")), level: 0, bullet: null });
  }
  return { title: title || fallbackTitle, slides: slides.flatMap(fit).filter((s) => s.lines.length || s.table) };
}

/** A slide split into as many slides as it needs so nothing runs off the bottom. */
function fit(s: Slide): Slide[] {
  const out: Slide[] = [];
  const name = (n: number) => (n ? `${s.title} (continued)` : s.title);
  let page: Line[] = [];
  let used = 0;
  for (const l of s.lines) {
    const cost = lineCost(l);
    if (page.length && used + cost > (s.table ? 3 : MAX_LINES)) {
      out.push({ title: name(out.length), lines: page, table: null });
      page = [];
      used = 0;
    }
    page.push(l);
    used += cost;
  }
  if (!s.table) return page.length || !out.length ? [...out, { title: name(out.length), lines: page, table: null }] : out;
  const [head, ...body] = s.table;
  for (let r = 0; r < Math.max(1, body.length); r += MAX_ROWS) {
    out.push({ title: name(out.length), lines: r ? [] : page, table: [head, ...body.slice(r, r + MAX_ROWS)] });
  }
  return out;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

// 16:9, in EMUs (914,400 per inch).
const W = 12192000;
const H = 6858000;
const EMERALD = "047857";
const INK = "1F2933";

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const runXml = (r: Run, size: number, color = INK) =>
  `<a:r><a:rPr lang="en-US" sz="${size}"${r.bold ? ' b="1"' : ""}${r.italic ? ' i="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${r.code ? '<a:latin typeface="Consolas"/>' : ""}</a:rPr><a:t>${esc(r.text)}</a:t></a:r>`;

function lineXml(l: Line): string {
  const size = l.code ? 1400 : l.level ? 1800 : 2000;
  const indent = 342900;
  const props = l.bullet
    ? `<a:pPr marL="${indent * (l.level + 1)}" indent="-${indent}"><a:spcBef><a:spcPts val="600"/></a:spcBef>${/^\d/.test(l.bullet) ? `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod" startAt="${parseInt(l.bullet)}"/>` : `<a:buFont typeface="Arial"/><a:buChar char="${esc(l.bullet)}"/>`}</a:pPr>`
    : `<a:pPr marL="0" indent="0"><a:spcBef><a:spcPts val="${l.code ? 0 : 600}"/></a:spcBef><a:buNone/></a:pPr>`;
  return `<a:p>${props}${l.runs.map((r) => runXml(r, size)).join("")}</a:p>`;
}

const shape = (id: number, name: string, x: number, y: number, w: number, h: number, body: string, anchor = "t") =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;

const bar = (id: number, x: number, y: number, w: number, h: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${EMERALD}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;

function tableXml(id: number, rows: string[][], y: number): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = W - 2 * 685800;
  const rowH = 420000;
  const cell = (text: string, head: boolean) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${runXml({ text, bold: head }, 1600, head ? "FFFFFF" : INK)}</a:p></a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720">${["lnL", "lnR", "lnT", "lnB"].map((l) => `<a:${l} w="6350"><a:solidFill><a:srgbClr val="D1D5DB"/></a:solidFill></a:${l}>`).join("")}<a:solidFill><a:srgbClr val="${head ? EMERALD : "FFFFFF"}"/></a:solidFill></a:tcPr></a:tc>`;
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${Math.floor(width / cols)}"/>`).join("");
  const body = rows.map((r, i) => `<a:tr h="${rowH}">${Array.from({ length: cols }, (_, c) => cell(r[c] ?? "", i === 0)).join("")}</a:tr>`).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="685800" y="${y}"/><a:ext cx="${width}" cy="${rowH * rows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

const slideXml = (shapes: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

function titleSlide(title: string, subtitle: string): string {
  return slideXml(
    bar(2, 0, 0, 228600, H) +
      shape(3, "Title", 914400, 2057400, W - 1828800, 1600200, `<a:p>${runXml({ text: title, bold: true }, 4400)}</a:p>`, "b") +
      shape(4, "Subtitle", 914400, 3810000, W - 1828800, 685800, `<a:p>${runXml({ text: subtitle }, 1800, "6B7280")}</a:p>`),
  );
}

function contentSlide(s: Slide, n: number, total: number): string {
  const textH = s.table ? Math.min(1600200, 400000 * s.lines.reduce((k, l) => k + lineCost(l), 0)) : 4800600;
  const tableY = 1600200 + (s.lines.length ? textH + 114300 : 0);
  return slideXml(
    bar(2, 685800, 457200, 685800, 76200) +
      shape(3, "Title", 685800, 609600, W - 1371600, 838200, `<a:p>${runXml({ text: s.title, bold: true }, 3200)}</a:p>`, "ctr") +
      (s.lines.length ? shape(4, "Text", 685800, 1600200, W - 1371600, textH, s.lines.map(lineXml).join("")) : "") +
      (s.table ? tableXml(5, s.table, tableY) : "") +
      shape(6, "Number", W - 1371600, H - 533400, 685800, 304800, `<a:p><a:pPr algn="r"/>${runXml({ text: `${n} / ${total}` }, 1000, "9CA3AF")}</a:p>`),
  );
}

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Flash"><a:themeElements><a:clrScheme name="Flash"><a:dk1><a:srgbClr val="${INK}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="064E3B"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="${EMERALD}"/></a:accent1><a:accent2><a:srgbClr val="10B981"/></a:accent2><a:accent3><a:srgbClr val="0EA5E9"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="8B5CF6"/></a:accent5><a:accent6><a:srgbClr val="EF4444"/></a:accent6><a:hlink><a:srgbClr val="${EMERALD}"/></a:hlink><a:folHlink><a:srgbClr val="064E3B"/></a:folHlink></a:clrScheme><a:fontScheme name="Flash"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Flash"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${'<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';

const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const rels = (items: [string, string][]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;

/** A .pptx deck for some Markdown, with a title slide saying `subtitle` (like the date). */
export function slidesDeck(markdown: string, fallbackTitle: string, subtitle: string): Uint8Array {
  const { title, slides } = slidesOf(markdown, fallbackTitle);
  const xml = [titleSlide(title, subtitle), ...slides.map((s, i) => contentSlide(s, i + 2, slides.length + 1))];
  const ct = "application/vnd.openxmlformats-officedocument.presentationml";
  return zip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${ct}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${ct}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${ct}.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${xml.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${ct}.slide+xml"/>`).join("")}</Types>`,
    ],
    ["_rels/.rels", rels([["officeDocument", "ppt/presentation.xml"]])],
    [
      "ppt/presentation.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${xml.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      rels([["slideMaster", "slideMasters/slideMaster1.xml"], ["theme", "theme/theme1.xml"], ...xml.map((_, i): [string, string] => ["slide", `slides/slide${i + 1}.xml`])]),
    ],
    ["ppt/slideMasters/slideMaster1.xml", MASTER],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([["slideLayout", "../slideLayouts/slideLayout1.xml"], ["theme", "../theme/theme1.xml"]])],
    ["ppt/slideLayouts/slideLayout1.xml", LAYOUT],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["slideMaster", "../slideMasters/slideMaster1.xml"]])],
    ["ppt/theme/theme1.xml", THEME],
    ...xml.map((x, i): [string, string] => [`ppt/slides/slide${i + 1}.xml`, x]),
    ...xml.map((_, i): [string, string] => [`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([["slideLayout", "../slideLayouts/slideLayout1.xml"]])]),
  ]);
}
