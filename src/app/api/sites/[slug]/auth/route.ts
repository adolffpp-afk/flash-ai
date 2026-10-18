import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { isSecure, readCookie } from "@/lib/server/auth.ts";
import { clientIp } from "@/lib/server/limits.ts";
import { FORM_COOKIE, SITE_COOKIE, siteAuth } from "@/lib/server/site-auth.ts";
import { siteForDomain } from "@/lib/server/domains.ts";
import { countSteps, matchVisit } from "@/lib/server/funnel.ts";
import { isOwnHost } from "@/lib/site-host.ts";

export const dynamic = "force-dynamic";

/**
 * Signing up, in or out of a published app. The app's browser sends this as an ordinary form, like
 * following a link, because an app has no origin of its own and so can't keep a cookie any other
 * way. Flash sets the cookie here and sends the visitor straight back to the app.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/auth">) {
  const { slug } = await ctx.params;
  const form = await request.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value : "";
  };
  // Where the visitor goes back to, decided here and never from the form: the app on its own
  // domain, or its page on Flash.
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  const ownDomain = !isOwnHost(host) && (await siteForDomain(host)) === slug;
  const back = ownDomain ? "/" : `/p/${slug}`;

  // The form must carry this browser's own key (see serve-site.ts): a page elsewhere can't read it, so
  // it can't sign a visitor in as someone else, or out.
  const key = readCookie(request, FORM_COOKIE);
  const sent = field("form_key");
  if (!key || !sent || key.length !== sent.length || !timingSafeEqual(Buffer.from(key), Buffer.from(sent))) {
    const url = new URL(back, request.url);
    url.searchParams.set("flash_auth", "unknown");
    return new Response(null, { status: 303, headers: { Location: url.pathname + url.search, "Cache-Control": "no-store" } });
  }
  const { result, cookie, joined } = await siteAuth(
    slug,
    field("action"),
    { email: field("email"), password: field("password"), name: field("name"), page: field("page") },
    clientIp(request),
    back,
    isSecure(request),
    readCookie(request, SITE_COOKIE),
  );
  const url = new URL(back, request.url);
  url.searchParams.set("flash_auth", result);
  const headers = new Headers({ Location: url.pathname + url.search, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  // A new member counts as a sign-up for the visit they came on (see funnel.ts), after the answer.
  if (joined && result === "ok") after(async () => countSteps(slug, await matchVisit(slug, request), ["signup"]));
  // 303 so the browser follows with a plain page request, not another form send.
  return new Response(null, { status: 303, headers });
}
