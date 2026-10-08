"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltApp } from "@/lib/types";
import { api } from "@/lib/store";
import { flashDbShim, injectHead } from "@/lib/flashdb-shim";
import { appSlug, projectZip } from "@/lib/app-project";
import { PREVIEW_BRIDGE, fixRequest, friendlyError, isPreviewMessage, linesIn, type PickedElement, type PreviewError } from "@/lib/preview-bridge";

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
  const [draft, setDraft] = useState(html);
  const changed = draft !== html;
  const btn = "rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className={`flex flex-col ${full ? "min-h-0 flex-1" : "h-[560px]"}`}>
      {onSave && (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
          <span className="min-w-0 flex-1">{changed ? "You have unsaved changes." : "Change the code here, then save to see it."}</span>
          <button className={btn} disabled={!changed} onClick={() => setDraft(html)}>
            Undo changes
          </button>
          <button
            className="rounded-md bg-brand px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-40"
            disabled={!changed || !draft.trim()}
            onClick={() => onSave(draft)}
          >
            Save
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
        aria-label="App code"
        className="min-h-0 w-full flex-1 resize-none bg-zinc-950/40 p-3 font-mono text-xs leading-relaxed text-zinc-300 outline-none"
      />
    </div>
  );
}

export function AppPreview({
  app,
  onPublished,
  publishedEarlier,
  onEditCode,
  onFix,
  onPick,
}: {
  app: BuiltApp & { slug?: string };
  onPublished?: (slug: string) => void;
  // Set when an earlier version of this app was published: Publish then updates that site.
  publishedEarlier?: string;
  // Saves code the user changed by hand as this version's code.
  onEditCode?: (html: string) => void;
  // Asks Flash to fix errors the preview hit (given for the latest version, which Flash builds on).
  onFix?: (request: string) => void;
  // Hands a part of the app the user clicked to the message box, to say what to change.
  onPick?: (picked: PickedElement) => void;
}) {
  const [view, setView] = useState<"preview" | "code">("preview");
  const [codeShown, setCodeShown] = useState(false);
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [publishedHtml, setPublishedHtml] = useState("");
  const [publishError, setPublishError] = useState("");
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  // Errors from the preview of this exact code (a new version or a restart starts clean).
  const [errors, setErrors] = useState<{ html: string; list: PreviewError[]; hidden?: boolean }>({ html: "", list: [] });
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewHtml = useMemo(() => injectHead(app.html, PREVIEW_HEAD), [app.html]);
  const link = app.slug && typeof window !== "undefined" ? `${window.location.origin}/p/${app.slug}` : "";
  const shownErrors = errors.html === app.html && !errors.hidden ? errors.list : [];

  // A new version of an already published app updates the same site, so its link, domain and prices stay.
  const target = app.slug ?? publishedEarlier;

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
      const res = await api<{ slug: string }>("/api/sites", {
        method: "POST",
        json: { html: app.html, title: app.title, slug: asNew ? undefined : target },
      });
      onPublished?.(res.slug);
      setPublishedHtml(app.html);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Couldn't publish.");
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
  const pane = full ? "min-h-0 flex-1" : app.kind === "slides" ? "aspect-video" : "h-[560px]";
  return (
    <div
      className={
        full
          ? "fixed inset-0 z-50 flex flex-col bg-zinc-950"
          : "mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <span className="flex gap-1" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-spark/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-gold/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-primary/80" />
        </span>
        <span className="ml-1 min-w-0 flex-1 truncate font-medium text-zinc-200">{app.title}</span>
        {/* On a phone the buttons wrap below the title and show icons only. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div className="mr-1 flex rounded-md border border-zinc-800" role="tablist">
            {(["preview", "code"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => {
                  setView(v);
                  if (v === "code") setCodeShown(true);
                }}
                className={`px-2 py-1 capitalize ${view === v ? "bg-primary/15 text-primary-soft" : ""}`}
              >
                {v}
              </button>
            ))}
          </div>
          {onPick && (
            <button
              className={`${btn} ${picking ? "bg-primary/15 text-primary-soft" : ""}`}
              onClick={() => choose(!picking)}
              aria-pressed={picking}
              aria-label="Select a part to change"
              title="Click a part of your app, then say what to change"
            >
              <span aria-hidden>◎</span>
              <span className="hidden sm:inline"> Select</span>
            </button>
          )}
          <button className={btn} onClick={restart} aria-label="Restart app" title="Restart">
            ↻
          </button>
          <button className={btn} onClick={() => setFull((f) => !f)} aria-label={full ? "Exit full screen" : "Full screen"}>
            <span className="sm:hidden" aria-hidden>
              {full ? "✕" : "⤢"}
            </span>
            <span className="hidden sm:inline">{full ? "Exit full screen" : "Full screen"}</span>
          </button>
          <div className="relative">
            <button className={`${btn} text-primary`} onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu" aria-label="Download">
              <span className="sm:hidden" aria-hidden>
                ⬇
              </span>
              <span className="hidden sm:inline">Download ▾</span>
            </button>
            {menu && (
              <>
                {/* A tap anywhere else closes the menu. */}
                <button type="button" aria-label="Close the download menu" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenu(false)} />
                <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
                  <button role="menuitem" className="block w-full px-3 py-2 text-left hover:bg-zinc-800" onClick={() => download("html")}>
                    <span className="block text-zinc-100">Web page (.html)</span>
                    <span className="block text-zinc-500">One file that opens in any browser.</span>
                  </button>
                  <button role="menuitem" className="block w-full px-3 py-2 text-left hover:bg-zinc-800" onClick={() => download("project")}>
                    <span className="block text-zinc-100">Project folder (.zip)</span>
                    <span className="block text-zinc-500">To keep coding in Cursor or VS Code.</span>
                  </button>
                </div>
              </>
            )}
          </div>
          {onPublished && !app.slug && publishedEarlier && (
            <button className={btn} onClick={() => publish(true)} disabled={publishing} title="Publish this version as a separate site">
              Publish as new
            </button>
          )}
          {onPublished && (
            <button
              className="ml-1 rounded-md bg-brand px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-50"
              onClick={() => publish()}
              disabled={publishing}
              title={!app.slug && publishedEarlier ? "Replace the published site with this version" : undefined}
            >
              {publishing
                ? "Publishing…"
                : app.slug
                  ? publishedHtml === app.html
                    ? "Published ✓"
                    : "Update"
                  : publishedEarlier
                    ? "Update site"
                    : "Publish"}
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
              <span className="text-emerald-300">Live at</span>
              <a href={link} target="_blank" rel="noreferrer" className="min-w-0 truncate text-primary-soft hover:underline">
                {link}
              </a>
              <button className={btn} onClick={copyLink}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </>
          )}
        </div>
      )}
      {picking && (
        <div role="status" className="flex items-center gap-2 border-b border-primary/20 bg-primary/10 px-3 py-2 text-xs text-primary-soft">
          <span className="min-w-0 flex-1">Click the part of your app you want to change.</span>
          <button className={btn} onClick={() => choose(false)}>
            Cancel
          </button>
        </div>
      )}
      {shownErrors.length > 0 && view === "preview" && !picking && (
        <div role="alert" className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <span className="min-w-0 flex-1 truncate" title={shownErrors.map((e) => friendlyError(e.message)).join("\n")}>
            ⚠ This app hit an error: {friendlyError(shownErrors[0].message)}
            {shownErrors.length > 1 && ` (and ${shownErrors.length - 1} more)`}
          </span>
          {onFix && (
            <button
              className="shrink-0 rounded-md bg-brand px-2.5 py-1 font-medium text-white hover:brightness-110"
              onClick={() => onFix(fixRequest(shownErrors, app.html))}
            >
              Fix it
            </button>
          )}
          <button className={`${btn} shrink-0`} onClick={() => setErrors({ ...errors, hidden: true })} aria-label="Hide the error">
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
        className={`w-full bg-white ${pane}`}
      />
      {/* Kept open once shown, so unsaved changes survive a look at the preview. */}
      {(view === "code" || codeShown) && (
        <div className={view === "code" ? "contents" : "hidden"}>
          <CodeEditor key={app.html} html={app.html} full={full} onSave={onEditCode && saveCode} />
        </div>
      )}
    </div>
  );
}
