/*
 * Small changes to an app Flash already built. Instead of writing the whole file again, the
 * builder can send only the pieces that change, which comes back in seconds instead of a minute
 * and costs a fraction as much. Each piece quotes the lines as they are now and the lines that
 * replace them.
 */

export type Edit = { find: string; replace: string };

/** The ```flash-edit line that opens a block of pieces. */
const OPENS = /```flash-edit/i;
const FIND = /^[ \t]*<{5,}[ \t]*(?:FIND|SEARCH)\b/i;
const SPLIT = /^[ \t]*={5,}[ \t]*$/;
const REPLACE = /^[ \t]*>{5,}[ \t]*REPLACE\b/i;
const CLOSES = /^[ \t]*```[ \t]*$/;

/** Whether some code is changed pieces rather than a whole file. */
export const hasPieces = (code: string) => code.split("\n").some((line) => FIND.test(line));

/**
 * Reads FIND/REPLACE pieces line by line from `from`. Inside a ```flash-edit block a ``` line
 * between pieces ends it; inside a piece it is just code. Markers out of place are counted as
 * broken, and so is a piece cut off halfway, so a change is never half made.
 */
function readPieces(text: string, from: number, fenced: boolean): { edits: Edit[]; broken: number; end: number } {
  const edits: Edit[] = [];
  let broken = 0;
  let state: "between" | "find" | "replace" = "between";
  let find: string[] = [];
  let replace: string[] = [];
  for (let at = from; at <= text.length; ) {
    const nl = text.indexOf("\n", at);
    const line = text.slice(at, nl === -1 ? text.length : nl);
    at = nl === -1 ? text.length + 1 : nl + 1;
    if (state === "between") {
      if (FIND.test(line)) {
        state = "find";
        find = [];
      } else if (fenced && CLOSES.test(line)) {
        return { edits, broken, end: Math.min(at, text.length) };
      } else if (SPLIT.test(line) || REPLACE.test(line)) {
        broken++;
      }
    } else if (state === "find") {
      if (SPLIT.test(line)) {
        state = "replace";
        replace = [];
      } else if (FIND.test(line) || REPLACE.test(line)) {
        broken++;
        state = FIND.test(line) ? "find" : "between";
        find = [];
      } else {
        find.push(line);
      }
    } else if (REPLACE.test(line)) {
      // Nothing between ======= and >>>>>>> REPLACE deletes the lines.
      edits.push({ find: find.join("\n"), replace: replace.join("\n") });
      state = "between";
    } else if (FIND.test(line) || SPLIT.test(line)) {
      broken++;
      state = FIND.test(line) ? "find" : "between";
      find = [];
    } else {
      replace.push(line);
    }
  }
  if (state !== "between") broken++;
  return { edits, broken, end: -1 };
}

/**
 * The changes in a reply, with the prose around them. `found` says a flash-edit block was there
 * at all, `open` that it never closed, and `broken` counts pieces that can't be read whole.
 */
export function splitEdits(text: string): { before: string; edits: Edit[]; after: string; open: boolean; broken: number; found: boolean } {
  const start = text.search(OPENS);
  if (start === -1) return { before: text, edits: [], after: "", open: false, broken: 0, found: false };
  const edits: Edit[] = [];
  let broken = 0;
  let after = "";
  let open = true;
  // Each block starts on the line after its ```flash-edit; prose between blocks is left out.
  for (let line = text.indexOf("\n", start); line !== -1; ) {
    const read = readPieces(text, line + 1, true);
    edits.push(...read.edits);
    broken += read.broken;
    if (read.end === -1) break;
    after = text.slice(read.end);
    const next = after.search(OPENS);
    if (next === -1) {
      open = false;
      break;
    }
    line = text.indexOf("\n", read.end + next);
    after = "";
  }
  return { before: text.slice(0, start), edits, after, open, broken, found: true };
}

/** Pieces sent inside an ```html block instead of a flash-edit one. */
export function piecesIn(code: string): { edits: Edit[]; broken: number } {
  const { edits, broken } = readPieces(code, 0, false);
  return { edits, broken };
}

/** Lines with the same words, ignoring how far they're indented and spaces at the end. */
const loose = (s: string) =>
  s
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

/**
 * Makes the changes to the app's code. A piece has to match exactly one place; if the quoted
 * lines differ only in spacing, the matching place is found by its words. Anything that doesn't
 * match is reported, so the whole file can be asked for instead.
 */
export function applyEdits(html: string, edits: Edit[]): { html: string; applied: number; failed: Edit[] } {
  let out = html;
  let applied = 0;
  const failed: Edit[] = [];
  for (const edit of edits) {
    if (!edit.find.trim()) {
      failed.push(edit);
      continue;
    }
    const first = out.indexOf(edit.find);
    if (first !== -1 && out.indexOf(edit.find, first + 1) === -1) {
      out = out.slice(0, first) + edit.replace + out.slice(first + edit.find.length);
      applied++;
      continue;
    }
    if (first !== -1) {
      // The same lines appear more than once: changing the wrong one would break the app.
      failed.push(edit);
      continue;
    }
    const found = looseMatch(out, edit.find);
    if (!found) {
      failed.push(edit);
      continue;
    }
    out = out.slice(0, found.start) + edit.replace + out.slice(found.end);
    applied++;
  }
  return { html: out, applied, failed };
}

/** Where the quoted lines sit in the code when only the spacing differs, if exactly one place matches. */
function looseMatch(html: string, find: string): { start: number; end: number } | null {
  const target = loose(find);
  if (!target) return null;
  const lines = html.split("\n");
  const count = find.split("\n").length;
  // Where each line starts in the whole file, so a match can be cut out again.
  const at: number[] = [];
  let pos = 0;
  for (const line of lines) {
    at.push(pos);
    pos += line.length + 1;
  }
  let hit: { start: number; end: number } | null = null;
  for (let i = 0; i + count <= lines.length; i++) {
    if (loose(lines.slice(i, i + count).join("\n")) !== target) continue;
    if (hit) return null;
    hit = { start: at[i], end: at[i + count - 1] + lines[i + count - 1].length };
  }
  return hit;
}
