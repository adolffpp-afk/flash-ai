import { TooManyAccounts, appUrl, canAdd, readCookie } from "@/lib/server/auth.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { OAUTH_COOKIE, PROVIDERS, checkState, clearStateCookie, fetchProfile, isProvider } from "@/lib/server/oauth.ts";
import { CLEAR_REF_COOKIE } from "@/lib/server/referrals.ts";
import { providerAccountId, signInWithProvider } from "@/lib/server/signin.ts";
import { signInCookie } from "@/lib/server/two-factor.ts";

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
    // A browser holds at most 5 accounts (see auth.ts): checked before an account is made or linked.
    if (!(await canAdd(request, await providerAccountId(profile)))) return fail("too_many_accounts");
    const result = await signInWithProvider(profile, request);
    if (!result.ok) return fail(result.code, `email ${result.code === "unverified" ? "not confirmed" : "missing"} at provider`);
    // With two-step sign-in on, this only gets them to the code page (see two-factor.ts).
    const { cookie, also, twoFactor, account } = await signInCookie(result.userId, request, saved.next, provider);
    cookies.push(cookie, ...also);
    // A new account has used the referral code (if any); it never applies twice.
    if (result.created) cookies.push(CLEAR_REF_COOKIE);
    return go(twoFactor ? "/signin/code" : account ? withTabAccount(saved.next, account) : saved.next);
  } catch (err) {
    if (err instanceof TooManyAccounts) return fail("too_many_accounts");
    return fail("failed", err instanceof Error ? err.message : "unknown error");
  }
}

/**
 * Where to go back to, telling Flash's page which account the tab is now on: the tab started this
 * on another account (adding one, see auth.ts), and keeps that one unless told.
 */
function withTabAccount(next: string, account: string): string {
  const url = new URL(next, "http://flash.invalid");
  if (url.pathname !== "/") return next;
  url.searchParams.set("as", account);
  return `${url.pathname}${url.search}${url.hash}`;
}
