import { isSecure, readCookie } from "@/lib/server/auth.ts";
import { clientIp } from "@/lib/server/limits.ts";
import { SITE_COOKIE, siteAuth } from "@/lib/server/site-auth.ts";
import { siteForDomain } from "@/lib/server/domains.ts";
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

  const { result, cookie } = await siteAuth(
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
  // 303 so the browser follows with a plain page request, not another form send.
  return new Response(null, { status: 303, headers });
}
