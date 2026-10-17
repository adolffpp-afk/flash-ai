/*
 * The live preview of an app or deck while Flash writes it. The builder sends the file as it is
 * written, in small "draft" events (see StreamEvent), and the page shows it beside the chat without
 * running any of it. A draft is only ever shown: it never becomes part of the reply, so it is never
 * saved, exported or shared, and the finished file still arrives once, in the "app" event.
 *
 * No model call is made for it: the drafts are the same text the one call is already writing.
 */
import { isDocument } from "./build-parse.ts";
import { hasPieces } from "./edit-blocks.ts";
import { msg } from "./i18n.ts";
import type { StreamEvent } from "./types.ts";

export type DraftEvent = Extract<StreamEvent, { type: "draft" }>;

// At most about two sends a second while the file is written…
export const DRAFT_EVERY_MS = 500;
// …unless this much is waiting.
export const DRAFT_CHUNK = 4_000;
// Nothing past this is drafted; the "app" event still carries the whole file.
export const DRAFT_MAX = 400_000;

/**
 * How much of the ```html block can be sent: all of it, except a last line that may still turn into
 * its closing fence (a newline and up to two backticks). The block ends just before the newline of
 * that fence (see splitBuild), so what is sent is always the start of the finished file.
 */
export function sendable(html: string, open: boolean): number {
  if (!open) return html.length;
  const q = html.lastIndexOf("\n");
  return q !== -1 && /^`{0,2}$/.test(html.slice(q + 1)) ? q : html.length;
}

/**
 * What one attempt of the builder sends of the file it is writing. base: there is an app to change,
 * so a block of pieces (FIND lines) or a snippet quoted in the answer is never drafted, as neither
 * becomes the app. now is the clock, so tests can set it.
 */
export function draftSender({ base, now = Date.now }: { base: boolean; now?: () => number }) {
  let sent = 0;
  let last = -Infinity;
  let off = false;
  // A first build's block is always the app; a change's only once it reads as a whole file.
  let doc = !base;
  // How far the lines have been looked through for pieces.
  let checked = 0;
  return {
    /** Whether part of a draft is on the page, so a fresh start has something to clear. */
    get sent() {
      return sent;
    },
    /** The next draft event for the block so far, or null when nothing should be sent yet. */
    next(html: string, open: boolean): DraftEvent | null {
      if (off) return null;
      if (base) {
        // Only the lines finished since the last look, so this stays as cheap as the text it adds.
        const upto = open ? html.lastIndexOf("\n") + 1 : html.length;
        if (upto > checked && hasPieces(html.slice(checked, upto))) {
          // Pieces sent in an html block are pieces, never the app: what was shown is taken back.
          off = true;
          const was = sent;
          sent = 0;
          return was ? { type: "draft", at: 0, delta: "" } : null;
        }
        checked = Math.max(checked, upto);
      }
      if (!doc) doc = isDocument(html);
      if (!doc) return null;
      const ready = Math.min(DRAFT_MAX, sendable(html, open));
      if (ready <= sent) return null;
      if (open && ready - sent < DRAFT_CHUNK && now() - last < DRAFT_EVERY_MS) return null;
      const e: DraftEvent = { type: "draft", at: sent, delta: html.slice(sent, ready) };
      sent = ready;
      last = now();
      return e;
    },
  };
}

// ---- The page's half: keeping the draft, and showing it without running any of it. ----

/**
 * Whether an event shows Flash has started writing the file: a draft of it, or the first pieces of a
 * change. Only then does the live preview open (or dim the app it shows), so a reply from the builder
 * that turns out to be words, such as a question or how to do something, never opens it.
 */
export function startsWriting(e: StreamEvent): boolean {
  return (e.type === "draft" && e.delta !== "") || (e.type === "status" && e.writing === true);
}

export type Draft = { reply: string; html: string; frozen: boolean };
const NO_DRAFT: Draft = { reply: "", html: "", frozen: false };

/**
 * The draft of the reply being written, for useSyncExternalStore: only the live preview reads it,
 * so the chat never renders again for a draft. A draft that misses a piece stops growing (frozen)
 * but stays on show, as what it holds is still the start of the file.
 */
export function draftStore() {
  let draft = NO_DRAFT;
  const listeners = new Set<() => void>();
  const set = (next: Draft) => {
    draft = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => draft,
    /** One draft event of the reply replyId. */
    apply(replyId: string, e: DraftEvent) {
      const now = draft.reply === replyId ? draft : { ...NO_DRAFT, reply: replyId };
      if (e.at === 0) {
        if (e.delta.length <= DRAFT_MAX && (now !== draft || now.html !== e.delta || now.frozen)) set({ reply: replyId, html: e.delta, frozen: false });
        return;
      }
      if (now.frozen) return;
      if (e.at === now.html.length && now.html.length + e.delta.length <= DRAFT_MAX) set({ ...now, html: now.html + e.delta });
      else set({ ...now, frozen: true });
    },
    /** Takes the draft away: only replyId's when given. */
    clear(replyId?: string) {
      if (draft === NO_DRAFT || (replyId !== undefined && draft.reply !== replyId)) return;
      set(NO_DRAFT);
    },
  };
}
export type DraftStore = ReturnType<typeof draftStore>;
export const NO_DRAFT_YET = NO_DRAFT;

/** Where the next "<tag" opens in lower (the page in lowercase), from index from, or -1. */
function tagAt(lower: string, tag: string, from: number): number {
  for (let i = lower.indexOf(`<${tag}`, from); i !== -1; i = lower.indexOf(`<${tag}`, i + 1)) {
    const after = lower.charAt(i + tag.length + 1);
    if (after === "" || /[\s/>]/.test(after)) return i;
  }
  return -1;
}

/** Each whole <tag …> in lower, as what is inside the brackets. Plain searches, so a long draft stays quick. */
function* tagsIn(lower: string, tag: string, from = 0): Generator<string> {
  for (let i = tagAt(lower, tag, from); i !== -1; i = tagAt(lower, tag, i + 1)) {
    const end = lower.indexOf(">", i);
    if (end === -1) return;
    yield lower.slice(i, end);
  }
}

/**
 * The tag opened at i with its own target attribute taken off and target="_blank" put in its place,
 * and the index just past it; null when it isn't finished. Its attributes are read as a browser reads
 * them, so a ">" in a quoted value doesn't end it, and each character is looked at once.
 */
function blankTargeted(html: string, i: number): [string, number] | null {
  const n = html.length;
  let j = i + 1;
  while (j < n && !/[\s/>]/.test(html[j])) j++;
  let out = "";
  let from = i;
  for (;;) {
    const before = j;
    while (j < n && /[\s/]/.test(html[j])) j++;
    if (j >= n) return null;
    // Before a closing "/", so an SVG link written as <a … /> stays empty.
    if (html[j] === ">") return [`${out}${html.slice(from, before)} target="_blank"${html.slice(before, j + 1)}`, j + 1];
    const name = j;
    while (++j < n && !/[\s/>=]/.test(html[j]));
    const target = html.slice(name, j).toLowerCase() === "target";
    let k = j;
    while (k < n && /\s/.test(html[k])) k++;
    if (html[k] === "=") {
      while (++k < n && /\s/.test(html[k]));
      if (html[k] === '"' || html[k] === "'") {
        const close = html.indexOf(html[k], k + 1);
        if (close === -1) return null;
        j = close + 1;
      } else {
        for (j = k; j < n && !/[\s>]/.test(html[j]); j++);
      }
    }
    if (target) {
      out += html.slice(from, before);
      from = j;
    }
  }
}

const LINK = /<a(?:rea)?[\s/>]/gi;

/**
 * The page with target="_blank" on every link (<a> and <area>, in an SVG too), whatever target it
 * had. An SVG link doesn't follow the page's <base target>, so one with no target would take the
 * frame itself away to the link.
 */
function blankTargets(html: string): string {
  let out = "";
  let at = 0;
  LINK.lastIndex = 0;
  for (let m = LINK.exec(html); m; m = LINK.exec(html)) {
    const tag = blankTargeted(html, m.index);
    // Not finished: the rest is all inside it.
    if (!tag) break;
    out += html.slice(at, m.index) + tag[0];
    at = LINK.lastIndex = tag[1];
  }
  return out + html.slice(at);
}

/**
 * The draft as markup to show while it is written. Nothing in it can run (the frame has no
 * scripts), so its scripts are left out, as are noscript blocks (they'd show with scripts off) and
 * a meta refresh; it ends before a tag, comment or script still being written; and its links
 * open nothing, so a tap never takes the frame away from the draft.
 */
export function draftView(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let at = 0;
  // Each found once and reused while it's still ahead, so a page with many scripts stays quick.
  let script = -2;
  let noscript = -2;
  for (;;) {
    if (script !== -1 && script < at) script = tagAt(lower, "script", at);
    if (noscript !== -1 && noscript < at) noscript = tagAt(lower, "noscript", at);
    const start = script === -1 ? noscript : noscript === -1 ? script : Math.min(script, noscript);
    if (start === -1) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, start);
    const tag = start === script ? "script" : "noscript";
    const close = lower.indexOf(`</${tag}`, start);
    const end = close === -1 ? -1 : lower.indexOf(">", close);
    // Not closed yet: the draft ends here for now.
    if (end === -1) break;
    at = end + 1;
  }
  // A meta refresh would take the frame to another page.
  let kept = "";
  let from = 0;
  const lowerKept = out.toLowerCase();
  for (let i = tagAt(lowerKept, "meta", 0); i !== -1; i = tagAt(lowerKept, "meta", i + 1)) {
    const end = lowerKept.indexOf(">", i);
    if (end === -1) break;
    if (/http-equiv\s*=\s*["']?\s*refresh/.test(lowerKept.slice(i, end))) {
      kept += out.slice(from, i);
      from = end + 1;
    }
  }
  out = kept + out.slice(from);
  // A comment, then a tag, still being written.
  const comment = out.lastIndexOf("<!--");
  if (comment !== -1 && comment > out.lastIndexOf("-->")) out = out.slice(0, comment);
  const open = out.lastIndexOf("<");
  if (open !== -1 && open > out.lastIndexOf(">")) out = out.slice(0, open);
  // Links open a new window, which the frame never may, so they do nothing. Each link is given that
  // target itself, as its own (such as _self), or none in an SVG, would take the frame away to the link.
  out = blankTargets(out);
  const lowerOut = out.toLowerCase();
  const head = tagAt(lowerOut, "head", 0);
  const after = head !== -1 ? head : tagAt(lowerOut, "html", 0) !== -1 ? tagAt(lowerOut, "html", 0) : lowerOut.indexOf("<!doctype");
  const at2 = after === -1 ? 0 : out.indexOf(">", after) + 1;
  return `${out.slice(0, at2)}<base target="_blank">${out.slice(at2)}`;
}

// The steps the live preview shows, in order, each reached when the file has got that far (see buildStep).
export const BUILD_STEPS = [msg("Page layout"), msg("Styles"), msg("Content"), msg("Interactions"), msg("Final checks")] as const;

/** How far the file has got: 0 to 4, an index into BUILD_STEPS. */
export function buildStep(html: string): number {
  const lower = html.toLowerCase();
  if (/id\s*=\s*["']?flash-data\b/.test(lower) || lower.includes("</body") || lower.includes("</html")) return 4;
  const body = tagAt(lower, "body", 0);
  if (body !== -1) {
    // A script in the page itself, not a library in the head or the app's data block.
    for (const script of tagsIn(lower, "script", body)) {
      if (!/type\s*=\s*["']?application\/(?:ld\+)?json/.test(script)) return 3;
    }
    return 2;
  }
  if (["header", "nav", "main", "section"].some((tag) => tagAt(lower, tag, 0) !== -1)) return 2;
  if (tagAt(lower, "style", 0) !== -1 || lower.includes("cdn.tailwindcss") || lower.includes("fonts.googleapis")) return 1;
  for (const link of tagsIn(lower, "link")) if (link.includes("stylesheet")) return 1;
  return 0;
}

/**
 * Whether the draft takes the place of the version on show. A first build's does at once. A change's
 * waits until the new file reaches Content, where its page starts to show (a deck only ever shows its
 * steps, so at once), so the version there now never gives way to an empty pane.
 */
export function draftShown(html: string, { changing, kind }: { changing: boolean; kind: "app" | "slides" }): boolean {
  return html !== "" && (!changing || kind === "slides" || buildStep(html) >= 2);
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** The words of the last heading written (h1 to h3), for "Writing: …"; "" when there is none. */
export function writingPart(html: string): string {
  const tail = html.slice(-20_000);
  const lower = tail.toLowerCase();
  let last = -1;
  for (const level of ["h1", "h2", "h3"]) {
    for (let i = tagAt(lower, level, 0); i !== -1; i = tagAt(lower, level, i + 1)) last = Math.max(last, i);
  }
  if (last === -1) return "";
  const open = tail.indexOf(">", last);
  if (open === -1) return "";
  const close = lower.indexOf("</h", open);
  // A heading is short: what's past this is never shown.
  let inside = tail.slice(open + 1, close === -1 ? undefined : close).slice(0, 2_000);
  const partial = inside.lastIndexOf("<");
  if (partial > inside.lastIndexOf(">")) inside = inside.slice(0, partial);
  const words = inside
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
  return words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words;
}
