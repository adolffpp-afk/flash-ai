import { SESSION_COOKIE, fromOwnPage, getUser, readCookie, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { domainsForSite, pointsAtFlash } from "@/lib/server/domains.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { newOwnerCode } from "@/lib/server/site-owner.ts";
import { OWNER_CODE_PARAM } from "@/lib/flashdb-shim.ts";

export const dynamic = "force-dynamic";

const MINUTE = 60_000;

/**
 * Open as owner, in My websites & apps: the address that opens the app as its owner once, on Flash
 * or on one of the app's own domains ({ domain }) that points at Flash now, with a one-time code
 * that lasts two minutes and works only at that address (see site-owner.ts). Only Flash's own pages
 * can ask (see fromOwnPage), so no link or other site can start owner mode. Custom domains can't
 * reach this (see site-host.ts).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/owner">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Open your app as its owner from Flash's own page.") }, { status: 403 });
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { domain?: unknown };
  const domain = typeof body.domain === "string" ? body.domain : "";
  if (domain && !(await domainsForSite(slug)).includes(domain)) return Response.json({ error: t("Not found") }, { status: 404 });
  if (await overLimit(`owner-code:${user.id}`, 30, 15 * MINUTE)) {
    return Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 });
  }
  // The code goes only to a domain that leads to Flash now, never to whoever else may hold it.
  if (domain && !(await pointsAtFlash(domain))) {
    return Response.json(
      { error: t("{domain} doesn't point at Flash right now, so your app can't open there as its owner. Open it on Flash instead.", { domain }) },
      { status: 409 },
    );
  }
  const code = await newOwnerCode(slug, user.id, readCookie(request, SESSION_COOKIE) ?? "", domain);
  if (!code) return Response.json({ error: t("Not found") }, { status: 404 });
  const query = `?${OWNER_CODE_PARAM}=${encodeURIComponent(code)}`;
  return Response.json({ url: domain ? `https://${domain}/${query}` : `/p/${slug}${query}` });
}
