import { one } from "./db.ts";
import { flashDbShim, injectHead } from "../flashdb-shim.ts";

// Published apps are served with a CSP sandbox, which gives them their own opaque origin:
// they can't read Flash's cookies or call Flash's private APIs, only the public flashDB endpoint.
// They still share Flash's domain (phishing pages would too), so publishing needs a confirmed
// email and is rate limited. TODO: serve them from a separate domain once one is bought.
const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";

/** A published app's page, with flashDB set up to talk to its own data, inbox and shop. */
export async function serveSite(slug: string | null): Promise<Response> {
  const site = slug ? await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]) : null;
  if (!slug || !site) {
    return new Response("<!doctype html><title>Not found</title><p style='font-family:sans-serif'>This app doesn't exist or was unpublished.</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const html = injectHead(site.html, flashDbShim(
    `/api/sites/${slug}/data`,
    `/api/sites/${slug}/inbox`,
    `/api/sites/${slug}/shop`,
    // Only sites that show prices ask for them, so other sites make no extra request.
    site.html.includes("data-flash-price"),
  ));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SANDBOX_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
}
