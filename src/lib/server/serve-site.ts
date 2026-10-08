import { one } from "./db.ts";
import { flashDbShim, injectHead, type Visitor } from "../flashdb-shim.ts";
import { SITE_COOKIE, newPageToken, visitorForSession } from "./site-auth.ts";
import { readCookie } from "./auth.ts";
import { hasOwnPreview, previewTags, sitePreview } from "../site-preview.ts";
import { SITE_URL } from "../../app/site.ts";

// Published apps are served with a CSP sandbox, which gives them their own opaque origin:
// they can't read Flash's cookies or call Flash's private APIs, only the public flashDB endpoint.
// They still share Flash's domain (phishing pages would too), so publishing needs a confirmed
// email and is rate limited. TODO: serve them from a separate domain once one is bought.
const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";

/**
 * A published app's page, with flashDB set up to talk to its own data, inbox and shop, and a share
 * card for its address (pageUrl) unless the site has its own.
 */
export async function serveSite(slug: string | null, pageUrl?: string, request?: Request): Promise<Response> {
  const site = slug ? await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]) : null;
  if (!slug || !site) {
    return new Response("<!doctype html><title>Not found</title><p style='font-family:sans-serif'>This app doesn't exist or was unpublished.</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const card =
    pageUrl && !hasOwnPreview(site.html)
      ? previewTags(sitePreview(site.html), pageUrl, `${(process.env.FLASH_APP_URL || SITE_URL).replace(/\/$/, "")}/p/${slug}/card`)
      : "";
  // Who is signed in to this app, if anyone, with a key that works on this page for a couple of
  // hours. The session cookie itself never reaches the app's own code.
  let visitor: Visitor = null;
  const who = request ? await visitorForSession(slug, readCookie(request, SITE_COOKIE)) : null;
  if (who) visitor = { user: who, token: await newPageToken(who.id, slug) };

  const html = injectHead(site.html, card + flashDbShim(
    `/api/sites/${slug}/data`,
    `/api/sites/${slug}/inbox`,
    `/api/sites/${slug}/shop`,
    // Only sites that show prices ask for them, so other sites make no extra request.
    site.html.includes("data-flash-price"),
    `/api/sites/${slug}/auth`,
    `/api/sites/${slug}/mine`,
    visitor,
  ));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SANDBOX_CSP,
      "X-Content-Type-Options": "nosniff",
      // Never kept by a shared cache: the page says who is signed in.
      "Cache-Control": "no-store, private",
    },
  });
}
