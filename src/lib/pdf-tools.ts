/*
 * Flash's PDF tools: merge, pick and turn pages, split, fill in forms, number pages and make a PDF
 * from photos. Everything runs on the user's device with pdf-lib (MIT), so files never leave it:
 * nothing is uploaded, stored or scanned, and the tools cost Flash nothing to run, so they're free.
 * PDFs are shown with pdf.js (Apache 2.0), which Flash already ships for reading attached PDFs.
 */
import { PDFBool, PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField, StandardFonts, degrees, rgb } from "pdf-lib";
import { msg } from "./i18n.ts";

/** The biggest PDF or photo the tools open, so a phone's tab isn't run out of memory. */
export const MAX_TOOL_MB = 100;
/** How many files Merge and Photos to PDF take at once. */
export const MAX_TOOL_FILES = 30;

export type PdfTool = "merge" | "pages" | "split" | "form" | "numbers" | "photos";

/** The tools in the order they're shown, each with its name and one line about it. */
export const PDF_TOOLS: { id: PdfTool; title: string; about: string; many: boolean }[] = [
  { id: "merge", title: msg("Merge PDFs"), about: msg("Join several PDFs into one, in the order you choose"), many: true },
  { id: "pages", title: msg("Organize pages"), about: msg("Move, turn or remove pages"), many: false },
  { id: "split", title: msg("Split or extract"), about: msg("Take out the pages you want, as one PDF or several"), many: false },
  { id: "form", title: msg("Fill in a form"), about: msg("Type into a PDF's form fields and save it"), many: false },
  { id: "numbers", title: msg("Number pages"), about: msg("Add page numbers at the bottom of each page"), many: false },
  { id: "photos", title: msg("Photos to PDF"), about: msg("Turn photos or scans into one PDF"), many: true },
];

/** Why a PDF couldn't be opened, as one of the tools' phrases. */
export class PdfToolError extends Error {}
export const LOCKED = msg("This PDF is locked with a password. Open it, save a copy without the password, then try again.");
export const CANT_FLATTEN = msg("Some answers use letters that can't be locked into the page. Untick \"Lock the answers\" to save the form with them.");
export const UNREADABLE = msg("Couldn't open this PDF. It may be damaged. Try saving it again as a PDF.");

/** Opens a PDF, or throws a PdfToolError that says why it can't be. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    const name = e instanceof Error ? `${e.name} ${e.message}` : "";
    throw new PdfToolError(/encrypt/i.test(name) ? LOCKED : UNREADABLE);
  }
}

/** How many pages a PDF has. */
export const pageCount = async (bytes: Uint8Array) => (await openPdf(bytes)).getPageCount();

/**
 * The pages a range like "1-3, 5, 8-" names, numbered from 1, in the order written, each once.
 * "8-" runs to the last page and "-3" from the first. Null when it names no page or one past the end.
 */
export function parseRanges(text: string, pages: number): number[][] | null {
  const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const ranges: number[][] = [];
  for (const part of parts) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) ?? /^(\d+)()$/.exec(part);
    if (!m) return null;
    const single = !part.match(/[-–]/);
    const from = m[1] ? Number(m[1]) : 1;
    const to = single ? from : m[2] ? Number(m[2]) : pages;
    if (from < 1 || to > pages || from > to) return null;
    ranges.push(Array.from({ length: to - from + 1 }, (_, i) => from + i));
  }
  return ranges;
}

/** Each page in a range once, in the order first named. */
export const uniquePages = (ranges: number[][]) => [...new Set(ranges.flat())];

/** Several PDFs joined in the order given. */
export async function mergePdfs(files: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const bytes of files) {
    const doc = await openPdf(bytes);
    for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
  }
  return out.save();
}

/** A page as Organize shows it: its number in the original (from 1) and how far it's turned, in degrees. */
export type PagePick = { page: number; turn: number };

/** A new PDF of the pages picked, in the order picked, each turned as asked on top of how it was. */
export async function pickPages(bytes: Uint8Array, picks: PagePick[]): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  const out = await PDFDocument.create();
  const copies = await out.copyPages(doc, picks.map((p) => p.page - 1));
  copies.forEach((page, i) => {
    const turn = (((page.getRotation().angle + picks[i].turn) % 360) + 360) % 360;
    page.setRotation(degrees(turn));
    out.addPage(page);
  });
  return out.save();
}

/** One PDF for each range. */
export async function splitPdf(bytes: Uint8Array, ranges: number[][]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const range of ranges) out.push(await pickPages(bytes, range.map((page) => ({ page, turn: 0 }))));
  return out;
}

/** The ranges that make one PDF of every page. */
export const everyPage = (pages: number) => Array.from({ length: pages }, (_, i) => [i + 1]);

/** A form field Fill in a form shows: text, a tick box, or a choice from options. */
export type FormField =
  | { name: string; kind: "text"; value: string; multiline: boolean }
  | { name: string; kind: "check"; value: boolean }
  | { name: string; kind: "choice"; value: string; options: string[] };

/** The fields a PDF's form has that Flash can fill, with what's in them now. Signature fields and buttons are left out. */
export async function formFields(bytes: Uint8Array): Promise<FormField[]> {
  const doc = await openPdf(bytes);
  const fields: FormField[] = [];
  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    if (field.isReadOnly()) continue;
    if (field instanceof PDFTextField) fields.push({ name, kind: "text", value: field.getText() ?? "", multiline: field.isMultiline() });
    else if (field instanceof PDFCheckBox) fields.push({ name, kind: "check", value: field.isChecked() });
    else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      fields.push({ name, kind: "choice", value: field.getSelected()[0] ?? "", options: field.getOptions() });
    } else if (field instanceof PDFRadioGroup) fields.push({ name, kind: "choice", value: field.getSelected() ?? "", options: field.getOptions() });
  }
  return fields;
}

/**
 * The PDF with its form filled in. Flattened, the answers become part of the page and can't be
 * changed; otherwise the form can still be edited in any PDF reader.
 */
export async function fillForm(bytes: Uint8Array, values: Record<string, string | boolean>, flatten: boolean): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  const form = doc.getForm();
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values) || field.isReadOnly()) continue;
    const value = values[name];
    if (field instanceof PDFTextField) {
      const text = String(value);
      const max = field.getMaxLength();
      field.setText(max ? text.slice(0, max) : text);
    } else if (field instanceof PDFCheckBox) {
      if (value) field.check();
      else field.uncheck();
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      if (value && field.getOptions().includes(String(value))) field.select(String(value));
      else if (!value) field.clear();
    } else if (field instanceof PDFRadioGroup) {
      if (value && field.getOptions().includes(String(value))) field.select(String(value));
      else if (!value) field.clear();
    }
  }
  // Text the form's own font can't write (most letters outside Western European ones) can't be
  // drawn here, so the form keeps its fields and the PDF reader draws them, as it would after typing
  // in it. Those answers can't be made part of the page.
  let drawn = true;
  try {
    form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
  } catch {
    drawn = false;
    form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  }
  if (flatten) {
    if (!drawn) throw new PdfToolError(CANT_FLATTEN);
    form.flatten();
  }
  return doc.save({ updateFieldAppearances: false });
}

export type NumberPlace = "center" | "right";

/** The PDF with "n / total" at the bottom of each page, from the page given (numbered from 1). */
export async function numberPages(bytes: Uint8Array, place: NumberPlace, from = 1): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const size = 10;
  pages.forEach((page, i) => {
    if (i + 1 < from) return;
    const label = `${i + 1 - from + 1} / ${pages.length - from + 1}`;
    const width = font.widthOfTextAtSize(label, size);
    const { x, y, width: w } = page.getCropBox();
    // Turned pages are written along what reads as their bottom.
    const angle = page.getRotation().angle % 360;
    const h = page.getCropBox().height;
    const margin = 24;
    const along = place === "center" ? (angle === 90 || angle === 270 ? h : w) / 2 - width / 2 : (angle === 90 || angle === 270 ? h : w) - margin - width;
    const spot =
      angle === 90 ? { x: x + w - margin, y: y + along, rotate: 90 }
      : angle === 180 ? { x: x + w - along, y: y + h - margin, rotate: 180 }
      : angle === 270 ? { x: x + margin, y: y + h - along, rotate: 270 }
      : { x: x + along, y: y + margin - size / 2, rotate: 0 };
    page.drawText(label, { x: spot.x, y: spot.y, size, font, color: rgb(0.25, 0.25, 0.25), rotate: degrees(spot.rotate) });
  });
  return doc.save();
}

/** A photo for Photos to PDF: JPEG or PNG bytes (others are turned into PNG in the browser first). */
export type Photo = { bytes: Uint8Array; type: "jpg" | "png" };

/** A4 in PDF points, the page each photo is fitted on. */
const A4 = { w: 595.28, h: 841.89 };

/** One PDF with a page for each photo, fitted on an A4 page turned the way the photo is, with a small margin. */
export async function photosToPdf(photos: Photo[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const photo of photos) {
    const image = photo.type === "jpg" ? await out.embedJpg(photo.bytes) : await out.embedPng(photo.bytes);
    const wide = image.width > image.height;
    const page = out.addPage(wide ? [A4.h, A4.w] : [A4.w, A4.h]);
    const margin = 24;
    const { width, height } = image.scaleToFit(page.getWidth() - 2 * margin, page.getHeight() - 2 * margin);
    page.drawImage(image, { x: (page.getWidth() - width) / 2, y: (page.getHeight() - height) / 2, width, height });
  }
  return out.save();
}

/** A file name for what a tool made: the first file's name with a word after it, as a .pdf. */
export function outName(name: string, word: string, part?: number): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "document";
  return `${base}-${word}${part ? `-${part}` : ""}.pdf`;
}
