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

/** Reads the <title> of a generated page. */
export function htmlTitle(html: string, fallback: string): string {
  const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  return t || fallback;
}
