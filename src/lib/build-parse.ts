/** Splits a streamed reply into the prose around it and the single ```html block holding the app. */
export function splitBuild(text: string): { before: string; html: string | null; after: string; open: boolean } {
  const start = text.search(/```html[^\n]*\n/i);
  if (start === -1) return { before: text, html: null, after: "", open: false };
  const codeStart = text.indexOf("\n", start) + 1;
  const end = text.indexOf("\n```", codeStart);
  if (end === -1) return { before: text.slice(0, start), html: text.slice(codeStart), after: "", open: true };
  return {
    before: text.slice(0, start),
    html: text.slice(codeStart, end),
    after: text.slice(end + 4).replace(/^[^\n]*\n?/, ""),
    open: false,
  };
}

/** A whole HTML file, as opposed to a snippet quoted in an answer. */
export const isDocument = (code: string) => /<!doctype html|<html[\s>]|<body[\s>]/i.test(code);

/** Reads the <title> of a generated page. */
export function htmlTitle(html: string, fallback: string): string {
  const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  return t || fallback;
}

/** The ideas for what to add next that the builder lists after an app, as short requests for the Suggestions row. */
export function nextIdeas(after: string | undefined): string[] {
  if (!after) return [];
  const ideas: string[] = [];
  for (const raw of after.split("\n")) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const idea = m[1]
      .replace(/\*\*|__|`/g, "")
      .replace(/[.:;]+$/, "")
      .trim();
    if (idea.length >= 4 && idea.length <= 90 && !ideas.includes(idea)) ideas.push(idea);
    if (ideas.length === 4) break;
  }
  return ideas;
}
