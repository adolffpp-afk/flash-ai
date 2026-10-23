"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "@/lib/store";
import type { PickedElement } from "@/lib/preview-bridge";
import type { AppVersion } from "@/lib/app-versions";
import { htmlTitle } from "@/lib/build-parse";
import { BUILD_STEPS, NO_DRAFT_YET, buildStep, draftView, swapAt, writingPart, type DraftStore } from "@/lib/live-draft";
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

// A draft is shown again at most every 3 seconds, and only while it can be seen: each showing loads
// the page afresh, pictures and fonts too, as a frame with no permissions can't use the browser's cache.
const REDRAW_MS = 3000;
// Focus that goes into the page this soon after a Tab key press came from the keyboard.
const TABBED_IN_MS = 500;
// The Code view shows the end of the file, where Flash is writing.
const CODE_TAIL = 8_000;
// In a short window (a phone on its side) the space under the Preview tab is a strip: the preview keeps
// a usable height and the panel scrolls, and the steps and the note under the page give it their room.
const TALL = "min-h-96";
const SHORT_HIDDEN = "[@media(max-height:500px)]:hidden";

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
  drafting,
  live,
  busy,
  onPublished,
  onEditCode,
  onFix,
  onPick,
  onSeo,
  onPlans,
  versions = [],
  older,
  onShow,
  onBuildOn,
  tabKey,
  onDashboard,
  onDomain,
}: {
  drafts: DraftStore;
  // The latest message with an app, which Flash builds on.
  appMsg?: UIMessage;
  publishedEarlier?: string;
  // The reply Flash is writing an app or deck in, while it does; live when this page is reading it.
  building?: UIMessage;
  // Its draft takes the place of the latest app (see draftShown): at once for a first build, and
  // once a change's new file has a page to show.
  drafting: boolean;
  live: boolean;
  busy: boolean;
  onPublished: (messageId: string, slug: string) => void;
  onEditCode: (messageId: string, html: string) => void;
  onFix: (kind: "app" | "slides", request: string) => void;
  onPick: (kind: "app" | "slides", part: PickedElement) => void;
  // Opens a published app's search check (SEO).
  onSeo?: (slug: string) => void;
  // Opens the plans, where plans can be bought.
  onPlans?: () => void;
  // The chat's versions for History, and the earlier one shown in place of the latest, with the
  // site it would update (see siteOf). Flash still builds on the latest until one is built on.
  versions?: AppVersion[];
  older?: { message: UIMessage; publishedEarlier?: string };
  onShow?: (id: string) => void;
  onBuildOn?: (id: string) => void;
  // The chat's, for a preview opened in a new tab: it follows the version on show here.
  tabKey?: string;
  // The published app's dashboard (visitors, orders, data), as the preview's Dashboard tab.
  onDashboard?: () => void;
  // Connect domain, for a published app.
  onDomain?: (slug: string) => void;
}) {
  const t = useT();
  // Only this panel reads the draft, so only it renders again as the file grows.
  const draft = useSyncExternalStore(drafts.subscribe, drafts.get, () => NO_DRAFT_YET);
  const kind = building?.engine === "slides" || (!building && appMsg?.app?.kind === "slides") ? "slides" : "app";
  if (appMsg?.app) {
    const app = appMsg.app;
    const done = !appMsg.pending;
    // A change's new file, once it shows, covers the version there now, which stays mounted under it:
    // if the change is stopped or fails, that version comes back as it was (its data, screen and code).
    const covered = Boolean(building && drafting);
    const history = onShow && versions.length > 1 ? { list: versions, shown: older?.message.id ?? appMsg.id, onShow } : undefined;
    // An earlier version shows over the latest, which stays mounted under it, so going back keeps it as it was.
    const earlier = !building && older?.message.app ? older : undefined;
    const n = earlier ? (versions.find((v) => v.id === earlier.message.id)?.n ?? 0) : 0;
    return (
      <div className={`relative flex flex-1 flex-col ${TALL}`}>
        {earlier?.message.app && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div role="status" className="flex flex-wrap items-center gap-2 border-b border-gold/30 bg-gold/10 px-3 py-2 text-xs text-zinc-300">
              {/* On a phone the buttons go under the words. */}
              <span className="min-w-0 flex-[1_1_15rem]">
                {t("You're looking at version {n} of {count}. Your changes still go to the latest.", {
                  n: n.toLocaleString(t.locale),
                  count: versions.length.toLocaleString(t.locale),
                })}
              </span>
              <button onClick={() => onShow?.(appMsg.id)} className="rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100">
                {t("Back to latest")}
              </button>
              {onBuildOn && (
                <button
                  onClick={() => onBuildOn(earlier.message.id)}
                  disabled={busy}
                  className="rounded-md bg-brand px-2.5 py-1 font-medium text-on-brand hover:brightness-110 disabled:opacity-40"
                >
                  {t("Build on this version")}
                </button>
              )}
            </div>
            <AppPreview
              key={earlier.message.id}
              fill
              app={earlier.message.app}
              onPublished={(slug) => onPublished(earlier.message.id, slug)}
              publishedEarlier={earlier.publishedEarlier}
              onSeo={onSeo}
              onPlans={onPlans}
              versions={history}
              tabKey={tabKey}
              onDashboard={onDashboard}
              onDomain={onDomain}
            />
          </div>
        )}
        <div inert={covered || Boolean(earlier)} className={`flex min-h-0 flex-1 flex-col ${covered ? "invisible" : ""} ${earlier ? "hidden" : ""}`}>
          <AppPreview
            key={appMsg.id}
            fill
            app={app}
            onPublished={(slug) => onPublished(appMsg.id, slug)}
            publishedEarlier={publishedEarlier}
            onEditCode={done ? (html) => onEditCode(appMsg.id, html) : undefined}
            onFix={done && !busy ? (request) => onFix(app.kind, request) : undefined}
            onPick={done ? (part) => onPick(app.kind, part) : undefined}
            onSeo={onSeo}
            onPlans={onPlans}
            versions={history}
            tabKey={earlier ? undefined : tabKey}
            onDashboard={onDashboard}
            onDomain={onDomain}
          />
        </div>
        {building && covered && (
          <div className="absolute inset-0 z-20 flex flex-col">
            <LiveBuild html={draft.html} kind={kind} status={building.status} live={live} />
          </div>
        )}
        {building && !covered && (
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
  if (building) return <LiveBuild html={drafting ? draft.html : ""} kind={kind} status={building.status} live={live} />;
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
    <div className={`flex flex-1 flex-col ${TALL}`}>
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
        <div className={`border-b border-zinc-800 px-3 py-2 ${SHORT_HIDDEN}`}>
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
        </div>
      )}
      {live && (
        // Only a new step is read out, not every line written.
        <span className="sr-only" aria-live="polite">
          {t(BUILD_STEPS[step])}
        </span>
      )}
      {view === "code" ? (
        <DraftCode html={html} />
      ) : page ? (
        <>
          <DraftFrame markup={markup} title={title} />
          <p className={`border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-500 ${SHORT_HIDDEN}`}>{t("Buttons start working when it's finished.")}</p>
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
 * Redrawing waits while the pointer is on the page or keyboard focus is in it, so it can be looked
 * at, and while it can't be seen (under the Conversation tab, the panel hidden, another browser tab).
 */
function DraftFrame({ markup, title }: { markup: string; title: string }) {
  // started and loaded: when the frame underneath began loading its draft, and when it had (see swapAt).
  const [frames, setFrames] = useState<{ docs: string[]; keys: number[]; front: number; loading: boolean; started: number; loaded?: number }>({
    docs: [markup, ""],
    keys: [0, 1],
    front: 0,
    loading: false,
    started: 0,
  });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(false);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let inView = false;
    const check = () => setSeen(inView && !document.hidden);
    // Told at once, and whenever that changes: hidden (display: none), it's in no view.
    const observer = new IntersectionObserver((entries) => {
      inView = entries.at(-1)?.isIntersecting ?? inView;
      check();
    });
    observer.observe(el);
    document.addEventListener("visibilitychange", check);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  // Focus that came in with Tab: a keyboard user reading the page keeps their place in it. A click or
  // a tap focuses it too, but holds nothing once the pointer has gone (a touch is never seen here).
  useEffect(() => {
    let tabbed = -Infinity;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Tab") tabbed = performance.now();
    };
    const check = () =>
      setFocused(performance.now() - tabbed < TABBED_IN_MS && Boolean(box.current && document.activeElement && box.current.contains(document.activeElement)));
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", check);
    window.addEventListener("focus", check);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  useEffect(() => {
    if (!seen || hovered || focused || frames.loading || markup === frames.docs[frames.front]) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        last.current = now;
        // The frame underneath loads it afresh, and comes to the front once it has.
        setFrames((f) => {
          const back = 1 - f.front;
          const docs = [...f.docs];
          const keys = [...f.keys];
          docs[back] = markup;
          keys[back] = Math.max(...keys) + 1;
          return { ...f, docs, keys, loading: true, started: now, loaded: undefined };
        });
      },
      Math.max(0, last.current + REDRAW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [markup, seen, hovered, focused, frames]);

  // The frame underneath comes to the front a while after its load, once its fonts have come too, and
  // by SWAP_BY_MS after it started even if a picture in it hasn't loaded (see swapAt). While the page
  // is looked at, it waits, so the page that has the focus is never put underneath.
  useEffect(() => {
    if (!frames.loading || hovered || focused) return;
    const timer = setTimeout(
      () => setFrames((f) => (f.loading ? { ...f, front: 1 - f.front, loading: false } : f)),
      Math.max(0, swapAt(frames.started, frames.loaded) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [frames.loading, frames.started, frames.loaded, hovered, focused]);

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
          onLoad={() => setFrames((f) => (f.loading && f.front !== i && f.loaded === undefined ? { ...f, loaded: Date.now() } : f))}
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
