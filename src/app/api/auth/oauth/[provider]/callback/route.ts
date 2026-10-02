import { appUrl, createSession, isSecure, readCookie } from "@/lib/server/auth.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { OAUTH_COOKIE, PROVIDERS, checkState, clearStateCookie, fetchProfile, isProvider } from "@/lib/server/oauth.ts";
import { signInWithProvider } from "@/lib/server/signin.ts";

/** Where Google, GitHub and Microsoft send people back after they sign in there. */
export async function GET(request: Request, ctx: RouteContext<"/api/auth/oauth/[provider]/callback">) {
  const { provider } = await ctx.params;
  const origin = appUrl(request);
  if (!isProvider(provider)) return new Response("Not found", { status: 404 });
  // The attempt's cookie is cleared whatever happens, so it can't be used twice.
  const cookies = [clearStateCookie()];
  const go = (path: string) => {
    const headers = new Headers({ Location: `${origin}${path}`, "Cache-Control": "no-store" });
    for (const c of cookies) headers.append("Set-Cookie", c);
    return new Response(null, { status: 303, headers });
  };
  // Logs what went wrong (never the code or tokens) and sends the person back to sign in.
  const fail = (code: string, detail?: string) => {
    if (detail) console.error(`[flash] ${PROVIDERS[provider].name} sign-in failed: ${detail}`);
    return go(`/?auth_error=${code}`);
  };

  if (await overLimit(`oauth-ip:${clientIp(request)}`, 30, 15 * 60_000)) return fail("busy");
  const params = new URL(request.url).searchParams;
  // The person pressed Cancel on the provider's page.
  if (params.get("error")) return fail("cancelled");
  const saved = checkState(readCookie(request, OAUTH_COOKIE), provider, params.get("state"));
  if (!saved) return fail("expired", "state missing, expired or mismatched");
  const code = params.get("code");
  if (!code) return fail("failed", "no code returned");

  try {
    const profile = await fetchProfile(saved, code, origin);
    const result = await signInWithProvider(profile, request);
    if (!result.ok) return fail(result.code, `email ${result.code === "unverified" ? "not confirmed" : "missing"} at provider`);
    cookies.push(await createSession(result.userId, isSecure(request)));
    return go(saved.next);
  } catch (err) {
    return fail("failed", err instanceof Error ? err.message : "unknown error");
  }
}
