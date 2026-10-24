import { appUrl, flowAccount, isAdmin } from "@/lib/server/auth.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { finishSignin, socialOpenTo } from "@/lib/server/social.ts";
import { socialFlowOwner } from "@/lib/server/social-signin.ts";

/*
 * The redirect URL registered in Flash's app at X, Google and Pinterest, the same for each: a code
 * is traded only with the state of this signed-in user's own sign-in, and only with the network it
 * was started for (see finishSignin). The page it goes back to says only how it ended, in Flash's
 * words: never the network's error text, the code or a token, and the code isn't passed on as a
 * referrer (the owners also see Flash's short code for why it failed). In a browser signed in to
 * several accounts, it is the account that started it.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const flow = await socialFlowOwner(params.get("state"));
  const { user, as } = await flowAccount(request, flow?.userId ?? null);
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  const go = (outcome: string, why = "") => new Response(null, { status: 303, headers: { ...headers, Location: `${appUrl(request)}/?social=${outcome}${why ? `&why=${encodeURIComponent(why)}` : ""}${as}` } });
  if (!user || !socialOpenTo(user)) return go("failed");
  if (await overLimit(`social-callback:${user.id}`, 30, 15 * 60_000)) return go("failed");
  const done = await finishSignin(user.id, { state: params.get("state"), code: params.get("code"), error: params.get("error") }).catch((err) => {
    console.error("[flash] social sign-in failed", err instanceof Error ? err.name : "error");
    return { outcome: "failed" as const };
  });
  const why = "why" in done && typeof done.why === "string" && isAdmin(user) && /^[\w:.-]{1,80}$/.test(done.why) ? done.why : "";
  return go(done.outcome, why);
}
