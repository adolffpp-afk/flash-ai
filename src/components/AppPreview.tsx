"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BuiltApp } from "@/lib/types";
import { api, onRestored, onSeoScore, onUnpublished } from "@/lib/store";
import { flashDbShim, injectHead } from "@/lib/flashdb-shim";
import { dataLine, type DataSummary } from "@/lib/data-rules";
import { appSlug, projectZip } from "@/lib/app-project";
import { PREVIEW_BRIDGE, fixRequest, friendlyError, isPreviewMessage, linesIn, readPages, replaceText, textRequest, type PickedElement, type PreviewError, type PreviewPage } from "@/lib/preview-bridge";
import { useT } from "@/lib/use-t";
import { BAND_PILL, band } from "@/lib/seo-band";
import { markCodeDraft } from "@/lib/code-drafts";
import { onSettingChange, readSetting, writeSetting } from "@/lib/device-settings";
import { SIZE_PICKS, frameFor, previewSize } from "@/lib/preview-size";
import type { AppVersion } from "@/lib/app-versions";
import { openTab, shareToTab } from "@/lib/preview-tab";

// No allow-same-origin: generated code can't read Flash's storage or cookies.
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";

// The preview gets an in-memory flashDB, so trying an app never touches the published app's data,
// and a script that reports the errors it hits and the part the user picks.
const PREVIEW_HEAD = PREVIEW_BRIDGE + flashDbShim(null);
const HEAD_LINES = linesIn(PREVIEW_HEAD);

// Outlines of a computer, a tablet, a phone, a QR code, a clock turned back, an arrow back, a globe,
// code brackets, a turning arrow, a box with an arrow out of it and a chevron, for the toolbar.
const SHAPES = {
  "": "M3.5 5h17v11h-17z M9 20h6 M12 16v4",
  tablet: "M5.5 3h13v18h-13z M11 18h2",
  phone: "M8 3h8v18H8z M11 18h2",
  qr: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h3v3h-3z M17 17h3v3h-3z",
  history: "M12 7.5V12l3 2 M4 12a8 8 0 1 0 2.3-5.6 M4 3.5v3.5h3.5",
  back: "M9 5L4.5 9.5 9 14 M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9s1.2-6.4 3.7-9z",
  code: "M9 7l-5 5 5 5 M15 7l5 5-5 5",
  reload: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4v4.5H15",
  out: "M13.5 4.5H19.5V10.5 M19.5 4.5L11 13 M17 14v5H5V7h5",
  down: "M7 10l5 5 5-5",
  select: "M5 3l13 7-6 1.5L9.5 18z M13 13l5 5",
  text: "M5 6V4.5h14V6 M12 4.5v15 M9 19.5h6",
};

function Shape({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

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
  // Unsaved code, which Flash asks about before switching account away from it.
  const editor = useId();
  const unsaved = changed && Boolean(onSave);
  useEffect(() => {
    markCodeDraft(editor, unsaved);
    return () => markCodeDraft(editor, false);
  }, [editor, unsaved]);
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
  onPlans,
  versions,
  onBuildOn,
  tabKey,
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
  // Opens the plans, offered when publishing is refused at the free plan's number of apps.
  onPlans?: () => void;
  // The chat's versions, for History: picking one shows it in the live preview (see BuildPanel).
  versions?: { list: AppVersion[]; shown: string; onShow: (id: string) => void };
  // Makes this earlier version the newest again, so the next change builds on it (see bringBack).
  onBuildOn?: () => void;
  // Given to the preview on show for a chat: a tab opened from it follows the chat's app, whichever
  // version is on show, as Flash changes it (see preview-tab).
  tabKey?: string;
}) {
  const t = useT();
  const [view, setView] = useState<"preview" | "code">("preview");
  const [codeShown, setCodeShown] = useState(false);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [publishedHtml, setPublishedHtml] = useState("");
  const [publishError, setPublishError] = useState<{ message: string; code?: string } | null>(null);
  // Who may change the published app's data, said once it's published.
  const [dataNote, setDataNote] = useState<DataSummary | null>(null);
  // The search check of the page this publish put live, with the score of the one it replaced.
  const [publishSeo, setPublishSeo] = useState<{ score: number | null; issues: number; before?: number | null } | null>(null);
  // The site unpublished in My websites & apps since: it has no search check to open.
  const [unpublished, setUnpublished] = useState("");
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  // Edit text: words clicked in the preview change in place, and are written into the code for free.
  const [editing, setEditing] = useState(false);
  // Words changed in the preview that Flash couldn't find in the code by itself, offered to the builder.
  const [textAsk, setTextAsk] = useState<{ before: string; after: string } | null>(null);
  // The size picked on this device; slides always fill the width.
  const size = previewSize(
    useSyncExternalStore(onSettingChange, () => readSetting("previewSize"), () => ""),
    app.kind,
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [phone, setPhone] = useState(false);
  const [history, setHistory] = useState(false);
  // The app's pages (see the page picker), as this code's preview tells them.
  const [pages, setPages] = useState<{ html: string; list: PreviewPage[]; current: string } | null>(null);
  const [pageMenu, setPageMenu] = useState(false);
  const ownKey = useId();
  const [tabbed, setTabbed] = useState(false);
  const [qr, setQr] = useState({ link: "", svg: "" });
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
  // What a phone opens: the site this version went live on, or the one an earlier version did.
  const liveLink = target && typeof window !== "undefined" ? `${window.location.origin}/p/${target}` : "";

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const watch = new ResizeObserver(([entry]) => setStage({ width: entry.contentRect.width, height: entry.contentRect.height }));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The QR code is made here, in the browser, only once it's asked for.
  useEffect(() => {
    if (!phone || !liveLink || qr.link === liveLink) return;
    let gone = false;
    import("qrcode")
      .then(({ toString }) => toString(liveLink, { type: "svg", margin: 2, errorCorrectionLevel: "M" }))
      .then((svg) => {
        if (!gone) setQr({ link: liveLink, svg });
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [phone, liveLink, qr.link]);

  useEffect(
    () =>
      onUnpublished((slug) => {
        if (slug !== app.slug) return;
        setUnpublished(slug);
        setPublishSeo(null);
      }),
    [app.slug],
  );
  // After History > Bring back in My websites & apps, this version isn't the live one any more: its button reads Update again.
  useEffect(
    () =>
      onRestored((slug) => {
        if (slug === app.slug) setPublishedHtml("");
      }),
    [app.slug],
  );
  // The score shown follows the live page's as My websites & apps reads it (after History > Bring back,
  // or a look at the check): the one before stays only while the score is still this publish's.
  useEffect(
    () =>
      onSeoScore((slug, seo) => {
        if (slug === app.slug) setPublishSeo((shown) => shown && (shown.score === seo.score ? { ...shown, issues: seo.issues } : seo));
      }),
    [app.slug],
  );

  // What the preview reports: the errors it hits, and the part picked while choosing.
  const pick = useRef(onPick);
  const edit = useRef(onEditCode);
  useEffect(() => {
    pick.current = onPick;
    edit.current = onEditCode;
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
      } else if (data.type === "text-edited") {
        setEditing(false);
        const next = typeof data.before === "string" && typeof data.after === "string" ? replaceText(app.html, data.before, data.after) : null;
        if (next && edit.current) edit.current(next);
        else if (typeof data.before === "string" && typeof data.after === "string") setTextAsk({ before: data.before, after: data.after });
      } else if (data.type === "edit-cancelled") {
        setEditing(false);
      } else if (data.type === "pages") {
        const read = readPages(data);
        setPages(read && { html: app.html, ...read });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app.html]);

  function editText(on: boolean) {
    setEditing(on);
    setTextAsk(null);
    if (on) {
      setPicking(false);
      setView("preview");
    }
    frameRef.current?.contentWindow?.postMessage({ flashPreview: true, type: "edit", on }, "*");
  }

  function choose(on: boolean) {
    setPicking(on);
    if (on) {
      setEditing(false);
      setView("preview");
    }
    frameRef.current?.contentWindow?.postMessage({ flashPreview: true, type: "pick", on }, "*");
  }

  function restart() {
    setReload((r) => r + 1);
    setPages(null);
    setPicking(false);
    setEditing(false);
    setErrors({ html: "", list: [] });
  }

  function saveCode(html: string) {
    onEditCode?.(html);
    setPicking(false);
    setView("preview");
  }

  async function publish(asNew = false) {
    setPublishing(true);
    setPublishError(null);
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
      setPublishError(err instanceof Error ? { message: err.message, code: (err as Error & { code?: string }).code } : { message: t("Couldn't publish.") });
    } finally {
      setPublishing(false);
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // A tab opened from this preview shows what it shows, and follows each change.
  const tabFollows = Boolean(tabKey) || tabbed;
  useEffect(() => {
    if (tabFollows) shareToTab(tabKey ?? ownKey, app.html, app.title);
  }, [tabFollows, tabKey, ownKey, app.html, app.title]);

  function goTo(page: string) {
    setPageMenu(false);
    setView("preview");
    frameRef.current?.contentWindow?.postMessage({ flashPreview: true, type: "go", page }, "*");
  }

  useEffect(() => {
    if (!full && !picking && !editing && !menu && !phone && !history && !pageMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pageMenu) setPageMenu(false);
      else if (history) setHistory(false);
      else if (phone) setPhone(false);
      else if (menu) setMenu(false);
      else if (picking) choose(false);
      else if (editing) editText(false);
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
  const frame = frameFor(size, stage);
  return (
    <div
      className={
        // A container, so the toolbar can show words where the panel has room for them.
        `@container ${
          full
            ? "fixed inset-0 z-50 flex flex-col bg-zinc-950"
            : fill
              ? "flex h-full min-h-0 flex-col"
              : "mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
        }`
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        {/* Preview and Code as one pill, the way app builders show them; the one on show says its name. */}
        <div className="flex shrink-0 gap-0.5 rounded-full border border-zinc-800 bg-zinc-950/40 p-0.5" role="tablist">
          {(["preview", "code"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              aria-label={v === "preview" ? t("Preview") : t("Code")}
              title={v === "preview" ? t("Preview") : t("Code")}
              onClick={() => {
                setView(v);
                if (v === "code") setCodeShown(true);
              }}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${view === v ? "bg-primary/15 text-primary-soft" : "hover:text-zinc-100"}`}
            >
              <Shape d={v === "preview" ? SHAPES.globe : SHAPES.code} />
              {view === v && <span className="hidden @[28rem]:inline">{v === "preview" ? t("Preview") : t("Code")}</span>}
            </button>
          ))}
        </div>
        {/* The address bar: restart, the page on show (a picker when the app has pages), and open in a new tab. */}
        <div className="flex min-w-40 flex-1 items-center gap-0.5 rounded-full border border-zinc-800 bg-zinc-950/40 px-1 py-0.5">
          <button className="rounded-full p-1 hover:bg-zinc-800 hover:text-zinc-100" onClick={restart} aria-label={t("Restart app")} title={t("Restart")}>
            <Shape d={SHAPES.reload} />
          </button>
          {pages && pages.html === app.html ? (
            <div className="relative min-w-0 flex-1">
              <button
                className="flex w-full min-w-0 items-center justify-center gap-1 rounded-full px-2 py-1 text-zinc-200 hover:bg-zinc-800"
                onClick={() => setPageMenu((m) => !m)}
                aria-expanded={pageMenu}
                aria-haspopup="menu"
                aria-label={t("Pick a page")}
                title={t("Pick a page")}
              >
                <span dir="auto" className="min-w-0 truncate">
                  {pages.list.find((p) => p.id === pages.current)?.label ?? app.title}
                </span>
                <Shape d={SHAPES.down} />
              </button>
              {pageMenu && (
                <>
                  {/* A tap anywhere else closes it. */}
                  <button type="button" aria-label={t("Close")} className="fixed inset-0 z-10 cursor-default" onClick={() => setPageMenu(false)} />
                  <div role="menu" aria-label={t("Pages")} className="absolute start-1/2 top-full z-20 mt-1 max-h-80 w-56 -translate-x-1/2 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-zinc-300 shadow-xl rtl:translate-x-1/2">
                    {pages.list.map((p) => (
                      <button
                        key={p.id}
                        role="menuitem"
                        onClick={() => goTo(p.id)}
                        aria-current={p.id === pages.current || undefined}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-zinc-800 hover:text-zinc-100 ${p.id === pages.current ? "bg-primary/15 text-primary-soft" : ""}`}
                      >
                        <span dir="auto" className="min-w-0 flex-1 truncate">
                          {p.label}
                        </span>
                        <span dir="ltr" className="shrink-0 text-zinc-500">
                          /{p.id}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <span dir="auto" className="min-w-0 flex-1 truncate px-2 py-1 text-center text-zinc-200">
              {app.title}
            </span>
          )}
          <button
            className="rounded-full p-1 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={() => {
              if (openTab(tabKey ?? ownKey, app.html, app.title)) setTabbed(true);
            }}
            aria-label={t("Open in a new tab")}
            title={t("Open in a new tab. It updates by itself as Flash changes your app.")}
          >
            <Shape d={SHAPES.out} />
          </button>
        </div>
        {/* On a phone the buttons wrap below the address bar and show icons only; with no room even so, they wrap among themselves. */}
        <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {app.kind !== "slides" && view === "preview" && (
            <div className="me-1 flex rounded-md border border-zinc-800">
              {SIZE_PICKS.map((p) => (
                <button
                  key={p.size}
                  className={`px-1.5 py-1 hover:text-zinc-100 ${size === p.size ? "bg-primary/15 text-primary-soft" : ""}`}
                  onClick={() => writeSetting("previewSize", p.size)}
                  aria-pressed={size === p.size}
                  aria-label={t(p.label)}
                  title={t(p.label)}
                >
                  <Shape d={SHAPES[p.size]} />
                </button>
              ))}
            </div>
          )}
          {versions && versions.list.length > 1 && (
            <div className="relative">
              <button
                className={`${btn} inline-flex items-center gap-1 ${history ? "bg-primary/15 text-primary-soft" : ""}`}
                onClick={() => setHistory((h) => !h)}
                aria-expanded={history}
                aria-label={t("History")}
                title={compact ? t("History") : undefined}
              >
                <Shape d={SHAPES.history} />
                <span className={label}>{t("History")}</span>
              </button>
              {history && (
                <>
                  {/* A tap anywhere else closes it. */}
                  <button type="button" aria-label={t("Close")} className="fixed inset-0 z-10 cursor-default" onClick={() => setHistory(false)} />
                  <div role="dialog" aria-label={t("History")} className="absolute end-0 top-full z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-zinc-300 shadow-xl">
                    {/* Newest first: the one Flash builds on is at the top. */}
                    <ul>
                      {[...versions.list].reverse().map((v, i) => (
                        <li key={v.id}>
                          <button
                            onClick={() => {
                              setHistory(false);
                              versions.onShow(v.id);
                            }}
                            aria-current={v.id === versions.shown || undefined}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-zinc-800 hover:text-zinc-100 ${v.id === versions.shown ? "bg-primary/15 text-primary-soft" : ""}`}
                          >
                            <span className="shrink-0 font-medium">{t("Version {n}", { n: v.n.toLocaleString(t.locale) })}</span>
                            <span dir="auto" className="min-w-0 flex-1 truncate text-zinc-500">
                              {v.title}
                            </span>
                            {i === 0 && <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">{t("Latest")}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
          {onBuildOn && (
            <button
              className={`${btn} inline-flex items-center gap-1`}
              onClick={onBuildOn}
              aria-label={t("Build on this version")}
              title={t("Make this the newest version, so your next change builds on it")}
            >
              <Shape d={SHAPES.back} />
              <span className={label}>{t("Build on this version")}</span>
            </button>
          )}
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
          {(liveLink || onPublished) && (
            <div className="relative">
              <button
                className={`${btn} inline-flex items-center gap-1`}
                onClick={() => setPhone((p) => !p)}
                aria-expanded={phone}
                aria-label={t("Open on your phone")}
                title={compact ? t("Open on your phone") : undefined}
              >
                <Shape d={SHAPES.qr} />
                <span className={label}>{t("On your phone")}</span>
              </button>
              {phone && (
                <>
                  {/* A tap anywhere else closes it. */}
                  <button type="button" aria-label={t("Close")} className="fixed inset-0 z-10 cursor-default" onClick={() => setPhone(false)} />
                  <div role="dialog" aria-label={t("Open on your phone")} className="absolute end-0 top-full z-20 mt-1 w-64 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-zinc-300 shadow-xl">
                    {liveLink ? (
                      <>
                        {qr.link === liveLink ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`data:image/svg+xml;utf8,${encodeURIComponent(qr.svg)}`}
                            alt={t("QR code to open it on your phone")}
                            // White whatever the theme: scanners need a light edge around the code.
                            style={{ background: "#fff" }}
                            className="mx-auto h-40 w-40 rounded-lg p-1.5"
                          />
                        ) : (
                          <div className="mx-auto h-40 w-40 animate-pulse rounded-lg bg-zinc-800" />
                        )}
                        <p className="mt-2">{t("Scan with your phone's camera to open it.")}</p>
                        <p className="mt-1 truncate text-zinc-500" dir="ltr">
                          {liveLink}
                        </p>
                        {!app.slug && <p className="mt-2 text-zinc-400">{t("Your phone shows the published version. Press Update site to see these changes there.")}</p>}
                      </>
                    ) : (
                      <p>{t("Publish it, then scan its code here to open it on your phone.")}</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
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
            <>
              <span className="text-red-300">{publishError.message}</span>
              {publishError.code === "site_cap" && onPlans && (
                <button
                  className={`${btn} text-primary-soft`}
                  onClick={() => {
                    // The plans open under a full-screen preview, so the preview leaves full screen first.
                    setFull(false);
                    onPlans();
                  }}
                >
                  {t("Upgrade plan")}
                </button>
              )}
            </>
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
                  onClick={() => {
                    // My websites & apps opens under a full-screen preview, so the preview leaves full screen first.
                    setFull(false);
                    onSeo(app.slug!);
                  }}
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
      {editing && (
        <div role="status" className="flex items-center gap-2 border-b border-primary/20 bg-primary/10 px-3 py-2 text-xs text-primary-soft">
          <span className="min-w-0 flex-1">{t("Click any words in your app and type. Enter keeps the change, for free.")}</span>
          <button className={btn} onClick={() => editText(false)}>
            {t("Done")}
          </button>
        </div>
      )}
      {textAsk && !editing && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-gold/30 bg-gold/10 px-3 py-2 text-xs text-zinc-300">
          <span className="min-w-0 flex-[1_1_14rem]">{t("Flash couldn't find those words in your app's code by itself. Ask Flash to change them?")}</span>
          {onFix && (
            <button
              className="shrink-0 rounded-md bg-brand px-2.5 py-1 font-medium text-on-brand hover:brightness-110"
              onClick={() => {
                onFix(textRequest(textAsk.before, textAsk.after));
                setTextAsk(null);
              }}
            >
              {t("Ask Flash")}
            </button>
          )}
          <button
            className={`${btn} shrink-0`}
            onClick={() => {
              setTextAsk(null);
              restart();
            }}
          >
            {t("Undo")}
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
      {/* The iframe stays the same element whatever the size, so changing it keeps the app as it is. */}
      <div ref={stageRef} hidden={view !== "preview"} className={`relative w-full ${pane} ${frame ? "overflow-hidden bg-zinc-950" : ""}`}>
        <iframe
          ref={frameRef}
          key={reload}
          title={app.title}
          srcDoc={previewHtml}
          sandbox={SANDBOX}
          style={frame}
          className={frame ? "rounded-xl bg-paper shadow-xl ring-1 ring-zinc-700" : "block h-full w-full bg-paper"}
        />
        {/* The edit bar floats on the app, like in the best app builders: pick a part to ask about, or change words in place. */}
        {(onPick || onEditCode) && !picking && !editing && (
          <div className="absolute bottom-3 start-1/2 z-10 flex -translate-x-1/2 gap-0.5 rounded-full border border-zinc-700 bg-zinc-900/90 p-1 text-zinc-300 shadow-xl shadow-black/30 backdrop-blur rtl:translate-x-1/2">
            {onPick && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => choose(true)}
                aria-label={t("Select a part to change")}
                title={t("Click a part of your app, then say what to change")}
              >
                <Shape d={SHAPES.select} />
                <span className="hidden @[24rem]:inline">{t("Select")}</span>
              </button>
            )}
            {onEditCode && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => editText(true)}
                aria-label={t("Edit text")}
                title={t("Change words right on the page, for free")}
              >
                <Shape d={SHAPES.text} />
                <span className="hidden @[24rem]:inline">{t("Edit text")}</span>
              </button>
            )}
          </div>
        )}
      </div>
      {/* Kept open once shown, so unsaved changes survive a look at the preview. */}
      {(view === "code" || codeShown) && (
        <div className={view === "code" ? "contents" : "hidden"}>
          <CodeEditor key={app.html} html={app.html} full={full || fill} onSave={onEditCode && saveCode} />
        </div>
      )}
    </div>
  );
}
