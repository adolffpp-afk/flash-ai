import { appUrl, isSecure } from "@/lib/server/auth.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { authorizeUrl, isProvider, newState, stateCookie } from "@/lib/server/oauth.ts";

/** "Continue with …": remembers this attempt in a short-lived cookie and opens the provider's sign-in page. */
export async function GET(request: Request, ctx: RouteContext<"/api/auth/oauth/[provider]">) {
  const { provider } = await ctx.params;
  const origin = appUrl(request);
  if (!isProvider(provider)) return new Response("Not found", { status: 404 });
  if (await overLimit(`oauth-ip:${clientIp(request)}`, 30, 15 * 60_000)) {
    return Response.redirect(`${origin}/?auth_error=busy`, 303);
  }
  const state = newState(provider, new URL(request.url).searchParams.get("next"));
  const url = authorizeUrl(state, origin);
  if (!url) return Response.redirect(`${origin}/?auth_error=unavailable`, 303);
  return new Response(null, {
    status: 303,
    headers: { Location: url, "Set-Cookie": stateCookie(state, isSecure(request)), "Cache-Control": "no-store" },
  });
}
