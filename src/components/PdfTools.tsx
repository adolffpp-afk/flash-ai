"use client";

import { useEffect, useRef, useState } from "react";
import { msg } from "@/lib/i18n";
import { useT } from "@/lib/use-t";
import { loadPdfjs } from "@/lib/pdfjs-browser";
import {
  MAX_TOOL_FILES,
  MAX_TOOL_MB,
  PDF_TOOLS,
  PdfToolError,
  everyPage,
  fillForm,
  formFields,
  mergePdfs,
  numberPages,
  outName,
  pageCount,
  parseRanges,
  photosToPdf,
  pickPages,
  splitPdf,
  uniquePages,
  type FormField,
  type NumberPlace,
  type PagePick,
  type Photo,
  type PdfTool,
} from "@/lib/pdf-tools";
import { ICONS, Tile, type Hue } from "./Home";

const LOOK: Record<PdfTool, { d: string; hue: Hue }> = {
  merge: { d: ICONS.layers, hue: "violet" },
  pages: { d: ICONS.file, hue: "blue" },
  split: { d: ICONS.scissors, hue: "rose" },
  form: { d: ICONS.pen, hue: "teal" },
  numbers: { d: ICONS.lines, hue: "orange" },
  photos: { d: ICONS.images, hue: "pink" },
};

/** The most pages Organize draws a picture of; past that, pages show as numbers only. */
const MAX_THUMBS = 300;

type Picked = { name: string; bytes: Uint8Array };

/** Saves what a tool made to the user's downloads. */
function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A photo as JPEG or PNG bytes: others (WebP, GIF, BMP) are drawn and saved as PNG. */
async function photoBytes(file: File): Promise<Photo> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === "image/jpeg") return { bytes, type: "jpg" };
  if (file.type === "image/png") return { bytes, type: "png" };
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("no png");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: "png" };
}

/** A form field's name as people read it: its last part, without the [0]s PDF makers add. */
const fieldLabel = (name: string) => (name.split(".").pop() ?? name).replace(/\[\d+\]/g, "").replace(/[_]+/g, " ").trim() || name;

/**
 * Flash's PDF tools, from Everything Flash can do and the menu. Each runs in the browser (see
 * pdf-tools.ts): files never leave the device, so nothing is uploaded or charged.
 */
export function PdfTools({ onClose }: { onClose: () => void }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [tool, setTool] = useState<PdfTool | null>(null);
  const [files, setFiles] = useState<Picked[]>([]);
  const [photos, setPhotos] = useState<(Photo & { name: string; url: string })[]>([]);
  const [pages, setPages] = useState(0);
  const [picks, setPicks] = useState<PagePick[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [ranges, setRanges] = useState("");
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [lock, setLock] = useState(false);
  const [place, setPlace] = useState<NumberPlace>("center");
  const [from, setFrom] = useState(1);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const info = PDF_TOOLS.find((x) => x.id === tool);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Photo previews are let go when they're removed or the tools close.
  const photoUrls = useRef<string[]>([]);
  useEffect(() => {
    photoUrls.current = photos.map((p) => p.url);
  }, [photos]);
  useEffect(() => () => photoUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  function reset(next: PdfTool | null) {
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    setTool(next);
    setFiles([]);
    setPhotos([]);
    setPages(0);
    setPicks([]);
    setThumbs({});
    setRanges("");
    setFields(null);
    setValues({});
    setFrom(1);
    setError("");
    setDone(false);
  }

  /** Draws a small picture of each page for Organize, a page at a time, so the first show quickly. */
  async function drawThumbs(bytes: Uint8Array, count: number) {
    try {
      const pdfjs = await loadPdfjs();
      const task = pdfjs.getDocument({ data: bytes.slice() });
      const doc = await task.promise;
      for (let n = 1; n <= Math.min(count, MAX_THUMBS); n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 140 / Math.max(base.width, base.height) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const url = canvas.toDataURL("image/jpeg", 0.7);
        setThumbs((all) => ({ ...all, [n]: url }));
        page.cleanup();
      }
      await task.destroy();
    } catch {
      // Pages show as numbers instead.
    }
  }

  /** Adds the files picked or dropped to the open tool, or says why one can't be. */
  async function add(list: FileList | File[]) {
    if (!tool || !info) return;
    setError("");
    setDone(false);
    const chosen = [...list];
    const room = info.many ? MAX_TOOL_FILES - files.length - photos.length : 1;
    if (chosen.length > room) {
      setError(t("Up to {count} files at once.", { count: info.many ? MAX_TOOL_FILES : 1 }));
      if (!info.many) return;
    }
    for (const file of chosen.slice(0, Math.max(room, 0))) {
      if (file.size > MAX_TOOL_MB * 1024 * 1024) {
        setError(t("Each file must be {size} MB or smaller.", { size: MAX_TOOL_MB }));
        continue;
      }
      if (tool === "photos") {
        if (!file.type.startsWith("image/")) {
          setError(t("Only photos here: JPG, PNG or WebP."));
          continue;
        }
        try {
          const photo = await photoBytes(file);
          setPhotos((all) => [...all, { ...photo, name: file.name, url: URL.createObjectURL(file) }]);
        } catch {
          setError(t("Couldn't read {name}.", { name: file.name }));
        }
        continue;
      }
      if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
        setError(t("Only PDFs here."));
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const count = await pageCount(bytes);
        if (info.many) {
          setFiles((all) => [...all, { name: file.name, bytes }]);
          continue;
        }
        setFiles([{ name: file.name, bytes }]);
        setPages(count);
        setPicks(Array.from({ length: count }, (_, i) => ({ page: i + 1, turn: 0 })));
        setThumbs({});
        if (tool === "pages") void drawThumbs(bytes, count);
        if (tool === "form") {
          const found = await formFields(bytes);
          setFields(found);
          setValues(Object.fromEntries(found.map((f) => [f.name, f.value])));
        }
      } catch (e) {
        setError(t(e instanceof PdfToolError ? e.message : "Couldn't read {name}.", { name: file.name }));
      }
    }
  }

  /** Runs the open tool and downloads what it made. */
  async function run() {
    if (!tool) return;
    setWorking(true);
    setError("");
    setDone(false);
    try {
      const first = files[0]?.name ?? photos[0]?.name ?? "document";
      if (tool === "merge") download(await mergePdfs(files.map((f) => f.bytes)), outName(first, "merged"));
      else if (tool === "pages") download(await pickPages(files[0].bytes, picks), outName(first, "pages"));
      else if (tool === "form") download(await fillForm(files[0].bytes, values, lock), outName(first, "filled"));
      else if (tool === "numbers") download(await numberPages(files[0].bytes, place, from), outName(first, "numbered"));
      else if (tool === "photos") download(await photosToPdf(photos), outName(first, "photos"));
      setDone(true);
    } catch (e) {
      setError(t(e instanceof PdfToolError ? e.message : "Something went wrong. Try again."));
    }
    setWorking(false);
  }

  /** Split: the pages typed as one PDF, each range as its own, or every page as its own. */
  async function split(how: "one" | "each" | "every") {
    const file = files[0];
    const asked = how === "every" ? everyPage(pages) : parseRanges(ranges, pages);
    if (!file || !asked) return;
    setWorking(true);
    setError("");
    setDone(false);
    try {
      if (how === "one") download(await pickPages(file.bytes, uniquePages(asked).map((page) => ({ page, turn: 0 }))), outName(file.name, "pages"));
      else {
        const parts = await splitPdf(file.bytes, asked);
        // A short pause between downloads, so the browser asks once and then takes them all.
        for (const [i, part] of parts.entries()) {
          download(part, outName(file.name, "part", i + 1));
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      setDone(true);
    } catch (e) {
      setError(t(e instanceof PdfToolError ? e.message : "Something went wrong. Try again."));
    }
    setWorking(false);
  }

  const move = <T,>(list: T[], i: number, by: number): T[] => {
    const j = i + by;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  const small = "rounded-lg px-2 py-1 text-xs text-zinc-400 ring-1 ring-inset ring-white/10 transition hover:text-zinc-100 hover:ring-white/25 disabled:opacity-30 light:ring-black/10";
  const card = "rounded-2xl bg-white/[0.03] ring-1 ring-inset ring-white/10 light:bg-black/[0.02] light:ring-black/10";
  const chip = (on: boolean) =>
    `rounded-2xl px-3 py-2 text-left text-sm ring-1 ring-inset transition ${
      on ? "bg-primary/15 text-white ring-primary/60" : "bg-white/[0.03] text-zinc-300 ring-white/10 hover:ring-white/25 light:bg-black/[0.02] light:ring-black/10"
    }`;
  const primary = "w-full rounded-xl bg-white px-4 py-3 font-semibold text-zinc-950 transition hover:brightness-95 disabled:opacity-50";
  const has = tool === "photos" ? photos.length > 0 : files.length > 0;
  const asked = parseRanges(ranges, pages);
  const ready =
    !working &&
    (tool === "merge" ? files.length >= 2 : tool === "photos" ? photos.length > 0 : tool === "pages" ? picks.length > 0 : tool === "form" ? Boolean(fields?.length) : has);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-tools-title"
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-3xl border border-white/8 bg-zinc-950 text-zinc-100 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-6 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            {tool && (
              <button onClick={() => reset(null)} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Back")}>
                ←
              </button>
            )}
            <Tile d={tool ? LOOK[tool].d : ICONS.file} hue={tool ? LOOK[tool].hue : "blue"} size="sm" />
            <div className="min-w-0">
              <h2 id="pdf-tools-title" className="text-xl font-semibold tracking-tight">
                {info ? t(info.title) : t("PDF Tools")}
              </h2>
              <p className="mt-0.5 text-sm leading-relaxed text-zinc-400">{info ? t(info.about) : t("Free, and your files never leave your device.")}</p>
            </div>
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6 pt-3 sm:px-7">
          {!tool ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PDF_TOOLS.map((x) => (
                <button key={x.id} type="button" onClick={() => reset(x.id)} className={`flex items-center gap-3 p-4 text-left transition hover:ring-white/25 ${card}`}>
                  <Tile d={LOOK[x.id].d} hue={LOOK[x.id].hue} size="sm" />
                  <span className="min-w-0">
                    <span className="block font-medium">{t(x.title)}</span>
                    <span className="block text-xs leading-relaxed text-zinc-400">{t(x.about)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <>
              {/* Pick or drop files. One-file tools swap the file; Merge and Photos add to the list. */}
              {(info?.many || !has) && (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void add(e.dataTransfer.files);
                  }}
                  className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/15 px-4 py-6 text-center light:border-black/15"
                >
                  <button type="button" onClick={() => inputRef.current?.click()} className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:brightness-95">
                    {tool === "photos" ? t("Add photos") : info?.many ? t("Add PDFs") : t("Choose a PDF")}
                  </button>
                  <span className="text-xs text-zinc-500">{t("or drop files here")}</span>
                </div>
              )}
              <input
                ref={inputRef}
                type="file"
                multiple={info?.many}
                accept={tool === "photos" ? "image/*" : "application/pdf,.pdf"}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void add(e.target.files);
                  e.target.value = "";
                }}
              />

              {!info?.many && files[0] && (
                <div className={`flex items-center justify-between gap-3 px-4 py-3 text-sm ${card}`}>
                  <span className="min-w-0 truncate">
                    {files[0].name} · <span className="text-zinc-400">{pages === 1 ? t("1 page") : t("{count} pages", { count: pages })}</span>
                  </span>
                  <button type="button" onClick={() => reset(tool)} className={small}>
                    {t("Change")}
                  </button>
                </div>
              )}

              {tool === "merge" && files.length > 0 && (
                <ol className="space-y-1.5">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className={`flex items-center gap-2 px-3 py-2 text-sm ${card}`}>
                      <span className="w-5 text-zinc-500">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <button type="button" className={small} disabled={i === 0} onClick={() => setFiles(move(files, i, -1))} aria-label={t("Move up")}>↑</button>
                      <button type="button" className={small} disabled={i === files.length - 1} onClick={() => setFiles(move(files, i, 1))} aria-label={t("Move down")}>↓</button>
                      <button type="button" className={small} onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={t("Remove")}>✕</button>
                    </li>
                  ))}
                </ol>
              )}

              {tool === "photos" && photos.length > 0 && (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {photos.map((p, i) => (
                    <div key={p.url} className={`overflow-hidden ${card}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- a local photo, shown before it's used */}
                      <img src={p.url} alt={p.name} className="aspect-square w-full object-cover" />
                      <div className="flex justify-center gap-1 p-1.5">
                        <button type="button" className={small} disabled={i === 0} onClick={() => setPhotos(move(photos, i, -1))} aria-label={t("Move up")}>←</button>
                        <button type="button" className={small} disabled={i === photos.length - 1} onClick={() => setPhotos(move(photos, i, 1))} aria-label={t("Move down")}>→</button>
                        <button
                          type="button"
                          className={small}
                          onClick={() => {
                            URL.revokeObjectURL(p.url);
                            setPhotos(photos.filter((_, j) => j !== i));
                          }}
                          aria-label={t("Remove")}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {tool === "pages" && files[0] && (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {picks.map((p, i) => (
                    <div key={`${p.page}-${i}`} className={`flex flex-col items-center gap-1.5 p-2 ${card}`}>
                      <div className="flex h-28 w-full items-center justify-center overflow-hidden">
                        {thumbs[p.page] ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a picture of the page, drawn here
                          <img src={thumbs[p.page]} alt="" className="max-h-28 max-w-full bg-white shadow transition-transform" style={{ transform: `rotate(${p.turn}deg) scale(${p.turn % 180 ? 0.75 : 1})` }} />
                        ) : (
                          <span className="text-2xl font-semibold text-zinc-600">{p.page}</span>
                        )}
                      </div>
                      <span className="text-xs text-zinc-400">{t("Page {page}", { page: p.page })}</span>
                      <div className="flex gap-1">
                        <button type="button" className={small} disabled={i === 0} onClick={() => setPicks(move(picks, i, -1))} aria-label={t("Move up")}>←</button>
                        <button type="button" className={small} onClick={() => setPicks(picks.map((x, j) => (j === i ? { ...x, turn: (x.turn + 90) % 360 } : x)))} aria-label={t("Turn")}>↻</button>
                        <button type="button" className={small} disabled={i === picks.length - 1} onClick={() => setPicks(move(picks, i, 1))} aria-label={t("Move down")}>→</button>
                        <button type="button" className={small} onClick={() => setPicks(picks.filter((_, j) => j !== i))} aria-label={t("Remove")}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {tool === "split" && files[0] && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-sm font-medium text-zinc-200">{t("Pages")}</span>
                    <input
                      value={ranges}
                      onChange={(e) => setRanges(e.target.value)}
                      placeholder={t("For example 1-3, 5, 8-")}
                      className="mt-1.5 w-full rounded-2xl bg-white/[0.04] px-4 py-3 text-[15px] text-zinc-100 ring-1 ring-inset ring-white/10 placeholder:text-zinc-500 focus:outline-none focus:ring-primary/60 light:bg-black/[0.03]"
                    />
                  </label>
                  {ranges.trim() && !asked && <p className="text-xs text-rose-300">{t("Those pages aren't in this PDF. Its pages go from 1 to {count}.", { count: pages })}</p>}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <button type="button" disabled={!asked || working} onClick={() => void split("one")} className={primary}>
                      {t("Save these pages as one PDF")}
                    </button>
                    <button type="button" disabled={!asked || working} onClick={() => void split("each")} className="w-full rounded-xl px-4 py-3 font-semibold ring-1 ring-inset ring-white/15 transition hover:bg-white/[0.04] disabled:opacity-50 light:ring-black/15">
                      {t("Save each range as its own PDF")}
                    </button>
                  </div>
                  <button type="button" disabled={working} onClick={() => void split("every")} className={small}>
                    {t("Save every page as its own PDF")}
                  </button>
                </div>
              )}

              {tool === "form" && fields && (
                fields.length === 0 ? (
                  <p className="text-sm text-zinc-400">{t("This PDF has no form fields to fill in.")}</p>
                ) : (
                  <div className="space-y-3">
                    {fields.map((f) => (
                      <label key={f.name} className={f.kind === "check" ? "flex items-center gap-2 text-sm" : "block"}>
                        {f.kind === "check" ? (
                          <>
                            <input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} className="h-4 w-4 accent-primary" />
                            <span>{fieldLabel(f.name)}</span>
                          </>
                        ) : (
                          <>
                            <span className="text-sm font-medium text-zinc-200">{fieldLabel(f.name)}</span>
                            {f.kind === "choice" ? (
                              <select
                                value={String(values[f.name] ?? "")}
                                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                                className="mt-1.5 w-full rounded-2xl bg-white/[0.04] px-4 py-3 text-[15px] text-zinc-100 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-primary/60 light:bg-black/[0.03]"
                              >
                                <option value="">—</option>
                                {f.options.map((o) => (
                                  <option key={o} value={o}>{o}</option>
                                ))}
                              </select>
                            ) : f.multiline ? (
                              <textarea
                                rows={3}
                                value={String(values[f.name] ?? "")}
                                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                                className="mt-1.5 w-full resize-none rounded-2xl bg-white/[0.04] px-4 py-3 text-[15px] text-zinc-100 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-primary/60 light:bg-black/[0.03]"
                              />
                            ) : (
                              <input
                                value={String(values[f.name] ?? "")}
                                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                                className="mt-1.5 w-full rounded-2xl bg-white/[0.04] px-4 py-3 text-[15px] text-zinc-100 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-primary/60 light:bg-black/[0.03]"
                              />
                            )}
                          </>
                        )}
                      </label>
                    ))}
                    <label className={`flex items-start gap-3 p-4 text-sm ${card}`}>
                      <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
                      <span>
                        <span className="block font-medium">{t("Lock the answers")}</span>
                        <span className="block text-xs text-zinc-400">{t("They become part of the page and can't be changed.")}</span>
                      </span>
                    </label>
                  </div>
                )
              )}

              {tool === "numbers" && files[0] && (
                <div className="flex flex-wrap items-end gap-5">
                  <div>
                    <span className="text-sm font-medium text-zinc-200">{t("Where")}</span>
                    <div className="mt-1.5 flex gap-2">
                      <button type="button" onClick={() => setPlace("center")} className={chip(place === "center")} aria-pressed={place === "center"}>{t("Bottom centre")}</button>
                      <button type="button" onClick={() => setPlace("right")} className={chip(place === "right")} aria-pressed={place === "right"}>{t("Bottom right")}</button>
                    </div>
                  </div>
                  <label>
                    <span className="text-sm font-medium text-zinc-200">{t("Start on page")}</span>
                    <input
                      type="number"
                      min={1}
                      max={pages}
                      value={from}
                      onChange={(e) => setFrom(Math.min(Math.max(1, Math.round(Number(e.target.value) || 1)), pages))}
                      className="mt-1.5 block w-24 rounded-2xl bg-white/[0.04] px-4 py-2 text-[15px] text-zinc-100 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-primary/60 light:bg-black/[0.03]"
                    />
                  </label>
                </div>
              )}

              {error && <p className="text-sm text-rose-300" role="alert">{error}</p>}
              {done && <p className="text-sm text-emerald-300" role="status">{t("Done. Your PDF is in your downloads.")}</p>}

              {tool !== "split" && has && !(tool === "form" && fields?.length === 0) && (
                <button type="button" disabled={!ready} onClick={() => void run()} className={primary}>
                  {working ? t("Working…") : tool === "merge" ? t("Merge and download") : t("Save PDF")}
                </button>
              )}
            </>
          )}
          <p className="text-xs leading-relaxed text-zinc-500">{t(NOTE)}</p>
        </div>
      </div>
    </div>
  );
}

const NOTE = msg("Your files are worked on in this browser and never sent to Flash. Coming next: Word, Excel and PowerPoint to PDF, and signing.");
