import { translatedPage } from "../../../lib/server/page-translations.ts";

// No scripts run at all, and the page has an origin of its own: nothing on it can act as Flash or
// read what Flash keeps. Its links may open the original site in a new tab.
const SANDBOX_CSP = "sandbox allow-popups allow-popups-to-escape-sandbox";

/** A website translated with Translate a website, for anyone with the link, for a month. */
export async function GET(_request: Request, ctx: RouteContext<"/t/[id]">) {
  const { id } = await ctx.params;
  const html = await translatedPage(id);
  if (!html) {
    return new Response("<!doctype html><title>Not found</title><p style='font-family:sans-serif'>This translation doesn't exist or is more than a month old.</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SANDBOX_CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
