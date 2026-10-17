"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "@/lib/store";
import type { PickedElement } from "@/lib/preview-bridge";
import { htmlTitle } from "@/lib/build-parse";
import { BUILD_STEPS, NO_DRAFT_YET, buildStep, draftShown, draftView, writingPart, type DraftStore } from "@/lib/live-draft";
import { useT } from "@/lib/use-t";
import { AppPreview } from "./AppPreview";

const queries = new Map<string, MediaQueryList>();
const mediaList = (query: string) => {
  let list = queries.get(query);
  if (!list) queries.set(query, (list = window.matchMedia(query)));
  return list;
};

/** Whether a media query matches, kept up to date as the window changes; false on the server. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (change: () => void) => {
      const list = mediaList(query);
      list.addEventListener("change", change);
      return () => list.removeEventListener("change", change);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => mediaList(query).matches,
    () => false,
  );
}

// A draft is shown again at most once a second: each showing loads the page afresh.
const REDRAW_MS = 1000;
// A page's load waits for its pictures, which never hold back its text: a new draft comes to the
// front by this long after it started loading, so one slow picture never holds the preview still.
const SWAP_BY_MS = 1500;
// The Code view shows the end of the file, where Flash is writing.
const CODE_TAIL = 8_000;

const Dots = () => (
  <span className="flex shrink-0 gap-1" aria-hidden>
    <span className="h-2.5 w-2.5 rounded-full bg-spark/80" />
    <span className="h-2.5 w-2.5 rounded-full bg-gold/80" />
    <span className="h-2.5 w-2.5 rounded-full bg-primary/80" />
  </span>
);

const Spinner = ({ className = "h-5 w-5" }: { className?: string }) => (
  <span className={`${className} shrink-0 motion-safe:animate-spin rounded-full border-2 border-zinc-600 border-t-gold`} aria-hidden />
);

/**
 * The live preview: the latest app or deck of the chat, beside it on a wide screen (or under the
 * Chat / Preview switch on a phone). While Flash writes a new version it fills in from an empty page,
 * with the steps it has reached, and turns into the normal preview once the file is finished.
 */
export function BuildPanel({
  drafts,
  appMsg,
  publishedEarlier,
  building,
  live,
  busy,
  onPublished,
  onEditCode,
  onFix,
  onPick,
}: {
  drafts: DraftStore;
  // The latest message with an app, which Flash builds on.
  appMsg?: UIMessage;
  publishedEarlier?: string;
  // The reply Flash is writing an app or deck in, while it does; live when this page is reading it.
  building?: UIMessage;
  live: boolean;
  busy: boolean;
  onPublished: (messageId: string, slug: string) => void;
  onEditCode: (messageId: string, html: string) => void;
  onFix: (kind: "app" | "slides", request: string) => void;
  onPick: (kind: "app" | "slides", part: PickedElement) => void;
}) {
  const t = useT();
  // Only this panel reads the draft, so only it renders again as the file grows.
  const draft = useSyncExternalStore(drafts.subscribe, drafts.get, () => NO_DRAFT_YET);
  const kind = building?.engine === "slides" || (!building && appMsg?.app?.kind === "slides") ? "slides" : "app";
  // A change keeps the version there now on show until the new file has a page to show.
  const changing = Boolean(appMsg?.app);
  const shown = useMemo(() => draftShown(draft.html, { changing, kind }), [draft.html, changing, kind]);
  if (building && draft.reply === building.id && shown) {
    return <LiveBuild html={draft.html} kind={kind} status={building.status} live={live} />;
  }
  if (appMsg?.app) {
    const app = appMsg.app;
    const done = !appMsg.pending;
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AppPreview
          key={appMsg.id}
          fill
          app={app}
          onPublished={(slug) => onPublished(appMsg.id, slug)}
          publishedEarlier={publishedEarlier}
          onEditCode={done ? (html) => onEditCode(appMsg.id, html) : undefined}
          onFix={done && !busy ? (request) => onFix(app.kind, request) : undefined}
          onPick={done ? (part) => onPick(app.kind, part) : undefined}
        />
        {building && (
          // Changing it: the version there now stays on show, held still until the new one comes.
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/50 px-6">
            <p role="status" className="flex max-w-xs items-center gap-2.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 shadow-lg shadow-black/20">
              <Spinner className="h-4 w-4" />
              {building.status || (app.kind === "slides" ? t("Changing your slides…") : t("Changing your app…"))}
            </p>
          </div>
        )}
      </div>
    );
  }
  if (building) return <LiveBuild html="" kind={kind} status={building.status} live={live} />;
  return null;
}

/** The file as Flash writes it: its steps, the page so far (with nothing in it running), and its code. */
function LiveBuild({ html, kind, status, live }: { html: string; kind: "app" | "slides"; status?: string; live: boolean }) {
  const t = useT();
  const [view, setView] = useState<"preview" | "code">("preview");
  const markup = useMemo(() => draftView(html), [html]);
  const step = useMemo(() => buildStep(html), [html]);
  const part = useMemo(() => (step >= 2 ? writingPart(markup) : ""), [markup, step]);
  const title = htmlTitle(html, kind === "slides" ? t("Slides") : t("App"));
  // Pages show once their content starts; a deck shows one slide at a time with its scripts, so never.
  const page = kind === "app" && step >= 2;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <Dots />
        <span className="ms-1 min-w-0 flex-1 truncate font-medium text-zinc-200">{title}</span>
        <div className="flex shrink-0 rounded-md border border-zinc-800" role="tablist">
          {(["preview", "code"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`px-2 py-1 ${view === v ? "bg-primary/15 text-primary-soft" : ""}`}>
              {v === "preview" ? t("Preview") : t("Code")}
            </button>
          ))}
        </div>
      </div>
      {live && (
        <div className="border-b border-zinc-800 px-3 py-2">
          <ol aria-label={t("Build steps")} className="-mx-1.5 flex flex-wrap items-center gap-y-1 text-xs">
            {BUILD_STEPS.map((label, i) => (
              <li
                key={label}
                aria-current={i === step ? "step" : undefined}
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 ${
                  i < step ? "border-transparent text-primary-soft" : i === step ? "border-primary/50 bg-primary/10 text-zinc-100" : "border-transparent text-zinc-500"
                }`}
              >
                {i < step ? (
                  <span>✓</span>
                ) : i === step ? (
                  <span className="h-2.5 w-2.5 motion-safe:animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" aria-hidden />
                )}
                {t(label)}
              </li>
            ))}
          </ol>
          <p dir="auto" className="mt-1.5 truncate text-xs text-zinc-500">
            {part ? t("Writing: {part}", { part }) : status}
          </p>
          {/* Only a new step is read out, not every line written. */}
          <span className="sr-only" aria-live="polite">
            {t(BUILD_STEPS[step])}
          </span>
        </div>
      )}
      {view === "code" ? (
        <DraftCode html={html} />
      ) : page ? (
        <>
          <DraftFrame markup={markup} title={title} />
          <p className="border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">{t("Buttons start working when it's finished.")}</p>
        </>
      ) : (
        <div className={`flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-zinc-400 ${kind === "slides" ? "my-auto aspect-video w-full" : "min-h-0 flex-1"}`}>
          <Spinner className="h-6 w-6" />
          {status && <span className="max-w-xs">{status}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The page so far, in a frame where nothing may run (sandbox with no permissions). Two frames take
 * turns, so a new draft loads and paints under the one on show and the page never flashes blank.
 * Redrawing waits while the pointer is on the page or it has the focus, so it can be looked at.
 */
function DraftFrame({ markup, title }: { markup: string; title: string }) {
  const [frames, setFrames] = useState({ docs: [markup, ""], keys: [0, 1], front: 0, loading: false });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setFocused(Boolean(box.current && document.activeElement && box.current.contains(document.activeElement)));
    window.addEventListener("blur", check);
    window.addEventListener("focus", check);
    return () => {
      window.removeEventListener("blur", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  useEffect(() => {
    if (hovered || focused || frames.loading || markup === frames.docs[frames.front]) return;
    const timer = setTimeout(
      () => {
        last.current = Date.now();
        // The frame underneath loads it afresh, and comes to the front once it has.
        setFrames((f) => {
          const back = 1 - f.front;
          const docs = [...f.docs];
          const keys = [...f.keys];
          docs[back] = markup;
          keys[back] = Math.max(...keys) + 1;
          return { ...f, docs, keys, loading: true };
        });
      },
      Math.max(0, last.current + REDRAW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [markup, hovered, focused, frames]);

  // The frame underneath comes to the front by SWAP_BY_MS, even if a picture in it hasn't loaded.
  useEffect(() => {
    if (!frames.loading) return;
    const timer = setTimeout(() => setFrames((f) => (f.loading ? { ...f, front: 1 - f.front, loading: false } : f)), SWAP_BY_MS);
    return () => clearTimeout(timer);
  }, [frames.loading]);

  return (
    <div ref={box} className="relative isolate min-h-0 flex-1 bg-paper" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      {[0, 1].map((i) => (
        <iframe
          key={frames.keys[i]}
          title={title}
          // Underneath, not hidden: a hidden frame isn't painted, so it would show blank as it came forward.
          inert={i !== frames.front}
          // No permissions at all: no scripts, forms, pop-ups or navigation of Flash's page.
          sandbox=""
          srcDoc={frames.docs[i]}
          onLoad={() => {
            if (i === frames.front || !frames.loading) return;
            // Two animation frames on, so it has painted: brought forward at its load, it can show blank.
            requestAnimationFrame(() => requestAnimationFrame(() => setFrames((f) => (f.loading && f.front !== i ? { ...f, front: i, loading: false } : f))));
          }}
          className={`absolute inset-0 h-full w-full border-0 bg-paper ${i === frames.front ? "z-10" : ""}`}
        />
      ))}
    </div>
  );
}

/** The end of the file as it is written, following along unless the user scrolled up to read. */
function DraftCode({ html }: { html: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const tail = html.length > CODE_TAIL ? `…${html.slice(html.length - CODE_TAIL)}` : html;
  useEffect(() => {
    if (following.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [tail]);
  return (
    <pre
      ref={ref}
      dir="ltr"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
      className="min-h-0 flex-1 overflow-auto bg-zinc-950/40 p-3 text-left font-mono text-xs leading-relaxed whitespace-pre text-zinc-300"
    >
      {tail}
    </pre>
  );
}
