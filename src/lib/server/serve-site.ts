import { one } from "./db.ts";
import { flashDbShim, injectHead, type OwnerView, type Visitor } from "../flashdb-shim.ts";
import { SITE_COOKIE, newPageToken, visitorForSession } from "./site-auth.ts";
import { SESSION_COOKIE, readCookie, userForSession } from "./auth.ts";
import { newOwnerKey } from "./site-owner.ts";
import { translatorFor } from "./i18n.ts";
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
  const site = slug ? await one<{ html: string; user_id: string }>("SELECT html, user_id FROM sites WHERE slug = ?", [slug]) : null;
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
  const session = request ? readCookie(request, SITE_COOKIE) : null;
  const who = await visitorForSession(slug, session);
  if (who && session) visitor = { user: who, token: await newPageToken(who.id, slug, session) };
  // The app's owner, signed in to Flash, gets a key to change its shared data from the app itself.
  // Only Flash's own address gets their sign-in cookie, so this never happens on a custom domain.
  let owner: OwnerView = null;
  const flashSession = request ? readCookie(request, SESSION_COOKIE) : null;
  if (request && flashSession) {
    try {
      const user = await userForSession(flashSession);
      const key = user && user.id === site.user_id ? await newOwnerKey(slug, user.id, flashSession) : null;
      if (user && key) {
        // What the page tells the owner is in Flash's language for them.
        const t = await translatorFor(request, user.language);
        owner = {
          key,
          note: t(
            "Owner view: you can change this app's data here. Visitors can only do what you allow in Flash › My websites & apps › Data. To see it as a visitor, use a private window.",
          ),
          ended: t("Your owner view has ended. Reload the page to keep changing this app's data."),
        };
      }
    } catch (err) {
      // The page still works, just without owner mode.
      console.error("[flash] owner key failed", err);
    }
  }

  const html = injectHead(site.html, card + flashDbShim(
    `/api/sites/${slug}/data`,
    `/api/sites/${slug}/inbox`,
    `/api/sites/${slug}/shop`,
    // Only sites that show prices ask for them, so other sites make no extra request.
    site.html.includes("data-flash-price"),
    `/api/sites/${slug}/auth`,
    `/api/sites/${slug}/mine`,
    visitor,
    `/api/sites/${slug}/ai`,
    `/api/sites/${slug}/files`,
    owner,
  ));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SANDBOX_CSP,
      "X-Content-Type-Options": "nosniff",
      // Never kept by a shared cache: the page says who is signed in, and may hold the owner's key.
      "Cache-Control": "no-store, private",
    },
  });
}
