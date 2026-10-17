"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltApp } from "@/lib/types";
import { api, onUnpublished } from "@/lib/store";
import { flashDbShim, injectHead } from "@/lib/flashdb-shim";
import { dataLine, type DataSummary } from "@/lib/data-rules";
import { appSlug, projectZip } from "@/lib/app-project";
import { PREVIEW_BRIDGE, fixRequest, friendlyError, isPreviewMessage, linesIn, type PickedElement, type PreviewError } from "@/lib/preview-bridge";
import { useT } from "@/lib/use-t";
import { BAND_PILL, band } from "@/lib/seo-band";

// No allow-same-origin: generated code can't read Flash's storage or cookies.
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";

// The preview gets an in-memory flashDB, so trying an app never touches the published app's data,
// and a script that reports the errors it hits and the part the user picks.
const PREVIEW_HEAD = PREVIEW_BRIDGE + flashDbShim(null);
const HEAD_LINES = linesIn(PREVIEW_HEAD);

function save(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The app's code, editable when onSave is given. Remounted (with a fresh draft) when the code changes. */
function CodeEditor({ html, full, onSave }: { html: string; full: boolean; onSave?: (html: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(html);
  const changed = draft !== html;
  const btn = "rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className={`flex flex-col ${full ? "min-h-0 flex-1" : "h-[560px]"}`}>
      {onSave && (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
          <span className="min-w-0 flex-1">{changed ? t("You have unsaved changes.") : t("Change the code here, then save to see it.")}</span>
          <button className={btn} disabled={!changed} onClick={() => setDraft(html)}>
            {t("Undo changes")}
          </button>
          <button
            className="rounded-md bg-brand px-2.5 py-1 font-medium text-on-brand hover:brightness-110 disabled:opacity-40"
            disabled={!changed || !draft.trim()}
            onClick={() => onSave(draft)}
          >
            {t("Save")}
          </button>
        </div>
      )}
      <textarea
        value={draft}
        readOnly={!onSave}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (!onSave) return;
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            if (changed && draft.trim()) onSave(draft);
          } else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // Tab indents, like in a code editor. Escape, then Tab, moves on.
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: start, selectionEnd: end } = el;
            setDraft(`${draft.slice(0, start)}  ${draft.slice(end)}`);
            requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label={t("App code")}
        className="min-h-0 w-full flex-1 resize-none bg-zinc-950/40 p-3 font-mono text-xs leading-relaxed text-zinc-300 outline-none"
      />
    </div>
  );
}

export function AppPreview({
  app,
  fill = false,
  onPublished,
  publishedEarlier,
  onEditCode,
  onFix,
  onPick,
  onSeo,
}: {
  app: BuiltApp & { slug?: string };
  // Fills the live preview beside the chat (see BuildPanel), which draws its own frame around it.
  fill?: boolean;
  onPublished?: (slug: string) => void;
  // Set when an earlier version of this app was published: Publish then updates that site.
  publishedEarlier?: string;
  // Saves code the user changed by hand as this version's code.
  onEditCode?: (html: string) => void;
  // Asks Flash to fix errors the preview hit (given for the latest version, which Flash builds on).
  onFix?: (request: string) => void;
  // Hands a part of the app the user clicked to the message box, to say what to change.
  onPick?: (picked: PickedElement) => void;
  // Opens the published app's search check (SEO) in My websites & apps.
  onSeo?: (slug: string) => void;
}) {
  const t = useT();
  const [view, setView] = useState<"preview" | "code">("preview");
  const [codeShown, setCodeShown] = useState(false);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [publishedHtml, setPublishedHtml] = useState("");
  const [publishError, setPublishError] = useState("");
  // Who may change the published app's data, said once it's published.
  const [dataNote, setDataNote] = useState<DataSummary | null>(null);
  // The search check of the page this publish put live, with the score of the one it replaced.
  const [publishSeo, setPublishSeo] = useState<{ score: number | null; issues: number; before?: number | null } | null>(null);
  // The site unpublished in My websites & apps since: it has no search check to open.
  const [unpublished, setUnpublished] = useState("");
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  // Errors from the preview of this exact code (a new version or a restart starts clean).
  const [errors, setErrors] = useState<{ html: string; list: PreviewError[]; hidden?: boolean }>({ html: "", list: [] });
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewHtml = useMemo(() => injectHead(app.html, PREVIEW_HEAD), [app.html]);
  const link = app.slug && typeof window !== "undefined" ? `${window.location.origin}/p/${app.slug}` : "";
  const shownErrors = errors.html === app.html && !errors.hidden ? errors.list : [];
  const dataText = dataNote ? dataLine(dataNote, 8, t) : "";
  // The browser's own error messages stay as they are; Flash's explanation of one is translated.
  const explain = (message: string) => {
    const friendly = friendlyError(message);
    return friendly === message ? message : t(friendly);
  };

  // A new version of an already published app updates the same site, so its link, domain and prices stay.
  const target = app.slug ?? publishedEarlier;

  useEffect(
    () =>
      onUnpublished((slug) => {
        if (slug !== app.slug) return;
        setUnpublished(slug);
        setPublishSeo(null);
      }),
    [app.slug],
  );

  // What the preview reports: the errors it hits, and the part picked while choosing.
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow || !isPreviewMessage(e.data)) return;
      const data = e.data;
      if (data.type === "error") {
        // The scripts Flash puts at the top don't count, so the line is the app's own.
        const line = data.line > HEAD_LINES ? data.line - HEAD_LINES : 0;
        setErrors((prev) => {
          const mine = prev.html === app.html;
          const list = mine ? prev.list : [];
          if (list.length >= 10) return prev;
          return { html: app.html, list: [...list, { message: data.message, line }], hidden: mine && prev.hidden };
        });
      } else if (data.type === "picked") {
        setPicking(false);
        setFull(false);
        pick.current?.({ tag: data.tag, text: data.text, path: data.path, html: data.html, label: data.label });
      } else if (data.type === "pick-cancelled") {
        setPicking(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app.html]);

  function choose(on: boolean) {
    setPicking(on);
    if (on) setView("preview");
    frameRef.current?.contentWindow?.postMessage({ flashPreview: true, type: "pick", on }, "*");
  }

  function restart() {
    setReload((r) => r + 1);
    setPicking(false);
    setErrors({ html: "", list: [] });
  }

  function saveCode(html: string) {
    onEditCode?.(html);
    setPicking(false);
    setView("preview");
  }

  async function publish(asNew = false) {
    setPublishing(true);
    setPublishError("");
    try {
      const res = await api<{ slug: string; data?: DataSummary; seo?: { score: number | null; issues: number; before?: number | null } }>("/api/sites", {
        method: "POST",
        json: { html: app.html, title: app.title, slug: asNew ? undefined : target },
      });
      onPublished?.(res.slug);
      setUnpublished("");
      setPublishedHtml(app.html);
      setDataNote(res.data ?? null);
      setPublishSeo(res.seo ?? null);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : t("Couldn't publish."));
    } finally {
      setPublishing(false);
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  useEffect(() => {
    if (!full && !picking && !menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu) setMenu(false);
      else if (picking) choose(false);
      else setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const download = (kind: "html" | "project") => {
    setMenu(false);
    if (kind === "html") save(`${appSlug(app.title)}.html`, app.html, "text/html");
    else save(`${appSlug(app.title)}.zip`, projectZip(app, link) as Uint8Array<ArrayBuffer>, "application/zip");
  };

  const btn = "rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100";
  // The panel beside the chat is narrower than the window says, so there the buttons show icons
  // only, as on a phone, whatever the window's width.
  const compact = fill && !full;
  const label = compact ? "hidden" : "hidden sm:inline";
  const icon = compact ? undefined : "sm:hidden";
  const pane = full ? "min-h-0 flex-1" : app.kind === "slides" ? (fill ? "my-auto aspect-video" : "aspect-video") : fill ? "min-h-0 flex-1" : "h-[560px]";
  return (
    <div
      className={
        full
          ? "fixed inset-0 z-50 flex flex-col bg-zinc-950"
          : fill
            ? "flex h-full min-h-0 flex-col"
            : "mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <span className="flex gap-1" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-spark/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-gold/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-primary/80" />
        </span>
        {/* Keeps room for a few words of the title: the buttons wrap below it before it shrinks away. */}
        <span className="ms-1 min-w-24 flex-1 truncate font-medium text-zinc-200">{app.title}</span>
        {/* On a phone the buttons wrap below the title and show icons only; with no room even so, they wrap among themselves. */}
        <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          <div className="me-1 flex rounded-md border border-zinc-800" role="tablist">
            {(["preview", "code"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => {
                  setView(v);
                  if (v === "code") setCodeShown(true);
                }}
                className={`px-2 py-1 ${view === v ? "bg-primary/15 text-primary-soft" : ""}`}
              >
                {v === "preview" ? t("Preview") : t("Code")}
              </button>
            ))}
          </div>
          {onPick && (
            <button
              className={`${btn} ${picking ? "bg-primary/15 text-primary-soft" : ""}`}
              onClick={() => choose(!picking)}
              aria-pressed={picking}
              aria-label={t("Select a part to change")}
              title={t("Click a part of your app, then say what to change")}
            >
              <span aria-hidden>◎</span>
              <span className={label}> {t("Select")}</span>
            </button>
          )}
          <button className={btn} onClick={restart} aria-label={t("Restart app")} title={t("Restart")}>
            ↻
          </button>
          <button
            className={btn}
            onClick={() => setFull((f) => !f)}
            aria-label={full ? t("Exit full screen") : t("Full screen")}
            title={compact ? t("Full screen") : undefined}
          >
            <span className={icon} aria-hidden>
              {full ? "✕" : "⤢"}
            </span>
            <span className={label}>{full ? t("Exit full screen") : t("Full screen")}</span>
          </button>
          <div className="relative">
            <button
              className={`${btn} text-primary`}
              onClick={() => setMenu((m) => !m)}
              aria-expanded={menu}
              aria-haspopup="menu"
              aria-label={t("Download")}
              title={compact ? t("Download") : undefined}
            >
              <span className={icon} aria-hidden>
                ⬇
              </span>
              <span className={label}>{t("Download")} ▾</span>
            </button>
            {menu && (
              <>
                {/* A tap anywhere else closes the menu. */}
                <button type="button" aria-label={t("Close the download menu")} className="fixed inset-0 z-10 cursor-default" onClick={() => setMenu(false)} />
                <div role="menu" className="absolute end-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
                  <button role="menuitem" className="block w-full px-3 py-2 text-start hover:bg-zinc-800" onClick={() => download("html")}>
                    <span className="block text-zinc-100">{t("Web page (.html)")}</span>
                    <span className="block text-zinc-500">{t("One file that opens in any browser.")}</span>
                  </button>
                  <button role="menuitem" className="block w-full px-3 py-2 text-start hover:bg-zinc-800" onClick={() => download("project")}>
                    <span className="block text-zinc-100">{t("Project folder (.zip)")}</span>
                    <span className="block text-zinc-500">{t("To keep coding in Cursor or VS Code.")}</span>
                  </button>
                </div>
              </>
            )}
          </div>
          {onPublished && !app.slug && publishedEarlier && (
            <button className={btn} onClick={() => publish(true)} disabled={publishing} title={t("Publish this version as a separate site")}>
              {t("Publish as new")}
            </button>
          )}
          {onPublished && (
            <button
              className="ms-1 rounded-md bg-brand px-2.5 py-1 font-medium text-on-brand hover:brightness-110 disabled:opacity-50"
              onClick={() => publish()}
              disabled={publishing}
              title={!app.slug && publishedEarlier ? t("Replace the published site with this version") : undefined}
            >
              {publishing
                ? t("Publishing…")
                : app.slug
                  ? publishedHtml === app.html
                    ? t("Published ✓")
                    : t("Update")
                  : publishedEarlier
                    ? t("Update site")
                    : t("Publish")}
            </button>
          )}
        </div>
      </div>
      {(link || publishError) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs">
          {publishError ? (
            <span className="text-red-300">{publishError}</span>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-2 text-emerald-300">
                {t.node("Live at {link}", {
                  link: (
                    <a href={link} target="_blank" rel="noreferrer" className="min-w-0 truncate text-primary-soft hover:underline">
                      {link}
                    </a>
                  ),
                })}
              </span>
              <button className={btn} onClick={copyLink}>
                {copied ? t("Copied") : t("Copy link")}
              </button>
              {onSeo && app.slug && unpublished !== app.slug && (
                <button
                  className={`${btn} inline-flex items-center gap-1`}
                  onClick={() => onSeo(app.slug!)}
                  title={publishSeo?.score != null ? t("To fix: {count}", { count: publishSeo.issues.toLocaleString(t.locale) }) : t("How easy your app is to find on Google, and what to fix")}
                >
                  <span aria-hidden>🔎</span> {t("SEO")}
                  {publishSeo?.score != null && (
                    <>
                      <span aria-hidden className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${BAND_PILL[band(publishSeo.score)]}`}>
                        {publishSeo.score.toLocaleString(t.locale)}
                      </span>
                      <span className="sr-only">{t("Search check: {score} out of 100", { score: publishSeo.score.toLocaleString(t.locale) })}</span>
                      {publishSeo.before != null && publishSeo.before !== publishSeo.score && (
                        <span className="text-zinc-500">· {t("Was {score}", { score: publishSeo.before.toLocaleString(t.locale) })}</span>
                      )}
                    </>
                  )}
                </button>
              )}
              {dataText && <span className="basis-full text-zinc-400">{dataText}</span>}
            </>
          )}
        </div>
      )}
      {picking && (
        <div role="status" className="flex items-center gap-2 border-b border-primary/20 bg-primary/10 px-3 py-2 text-xs text-primary-soft">
          <span className="min-w-0 flex-1">{t("Click the part of your app you want to change.")}</span>
          <button className={btn} onClick={() => choose(false)}>
            {t("Cancel")}
          </button>
        </div>
      )}
      {shownErrors.length > 0 && view === "preview" && !picking && (
        <div role="alert" className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <span className="min-w-0 flex-1 truncate" title={shownErrors.map((e) => explain(e.message)).join("\n")}>
            ⚠{" "}
            {shownErrors.length === 1
              ? t("This app hit an error: {error}", { error: explain(shownErrors[0].message) })
              : shownErrors.length === 2
                ? t("This app hit an error: {error} (and 1 more)", { error: explain(shownErrors[0].message) })
                : t("This app hit an error: {error} (and {count} more)", {
                    error: explain(shownErrors[0].message),
                    count: (shownErrors.length - 1).toLocaleString(t.locale),
                  })}
          </span>
          {onFix && (
            <button
              className="shrink-0 rounded-md bg-brand px-2.5 py-1 font-medium text-on-brand hover:brightness-110"
              onClick={() => onFix(fixRequest(shownErrors, app.html))}
            >
              {t("Fix it")}
            </button>
          )}
          <button className={`${btn} shrink-0`} onClick={() => setErrors({ ...errors, hidden: true })} aria-label={t("Hide the error")}>
            ✕
          </button>
        </div>
      )}
      <iframe
        ref={frameRef}
        key={reload}
        title={app.title}
        srcDoc={previewHtml}
        sandbox={SANDBOX}
        hidden={view !== "preview"}
        className={`w-full bg-paper ${pane}`}
      />
      {/* Kept open once shown, so unsaved changes survive a look at the preview. */}
      {(view === "code" || codeShown) && (
        <div className={view === "code" ? "contents" : "hidden"}>
          <CodeEditor key={app.html} html={app.html} full={full || fill} onSave={onEditCode && saveCode} />
        </div>
      )}
    </div>
  );
}
