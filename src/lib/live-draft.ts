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
