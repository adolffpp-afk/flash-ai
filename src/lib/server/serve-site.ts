import { one } from "./db.ts";
import { OWNER_CODE_PARAM, flashDbShim, injectHead, type OwnerView, type Visitor } from "../flashdb-shim.ts";
import { SITE_COOKIE, newPageToken, visitorForSession } from "./site-auth.ts";
import { readCookie } from "./auth.ts";
import { ownerKeyForCode } from "./site-owner.ts";
import { translatorFor } from "./i18n.ts";
import { isOwnHost } from "../site-host.ts";
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
  const session = request ? readCookie(request, SITE_COOKIE) : null;
  const who = await visitorForSession(slug, session);
  if (who && session) visitor = { user: who, token: await newPageToken(who.id, slug, session) };
  // Owner mode, when the owner chose Open as owner in Flash: the one-time code in the address
  // becomes a key to change the app's shared data from the app itself (see site-owner.ts), here or
  // on the app's own domain. Opening the app any other way, even signed in to Flash, shows it as
  // visitors see it.
  const owner = request ? await ownerView(slug, request) : null;

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

/**
 * The owner's key for this page and what the page tells them, when its address carries a one-time
 * code from Flash's Open as owner; null without one. A code that doesn't work (used already, too
 * old) leaves the page as visitors see it, and says so.
 */
async function ownerView(slug: string, request: Request): Promise<OwnerView> {
  const code = new URL(request.url).searchParams.get(OWNER_CODE_PARAM);
  if (!code) return null;
  try {
    // On Flash's own address the code only ever comes from Flash's own page, never from another site.
    const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    const crossSite = request.headers.get("sec-fetch-site") === "cross-site" && isOwnHost(host);
    const made = crossSite ? null : await ownerKeyForCode(slug, code);
    // What the page tells the owner is in Flash's language for them.
    const t = await translatorFor(request, made?.language);
    if (!made) {
      return {
        key: "",
        note: t("This owner link has been used already or is too old, so you see the app as visitors do. Choose Open as owner in Flash › My websites & apps again."),
        ended: "",
      };
    }
    return {
      key: made.key,
      note: t("Owner view: you can change this app's data here until you reload or close this page. Visitors can only do what you allow in Flash › My websites & apps › Data."),
      ended: t("Your owner view has ended. Choose Open as owner in Flash › My websites & apps to keep changing this app's data."),
    };
  } catch (err) {
    // The page still works, just without owner mode.
    console.error("[flash] owner key failed", err);
    return null;
  }
}
