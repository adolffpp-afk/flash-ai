import { appUrl, flowAccount, jarSessions } from "@/lib/server/auth.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { githubFlowOwner, githubReady, installFlowOwner } from "@/lib/server/github.ts";
import { finishGithub } from "@/lib/server/connections.ts";

/*
 * The GitHub App's callback URL: where GitHub sends the browser after the authorize step, and after
 * the app is installed. A code is redeemed only with the state of this signed-in user's own authorize
 * step (see finishGithub); anything else redeems nothing. A token that sees no installation goes on to
 * the installation page, and an installation that came back without Flash's state goes on to the
 * authorize step again. The page it goes back to says only how it ended, in
 * Flash's own words: never GitHub's error text, the code or a token, and the code isn't passed on as a
 * referrer. It costs nothing. In a browser signed in to several accounts, it is the account that
 * started the sign-in or the installation (see flowAccount).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const owner = state ? await githubFlowOwner(state) : await installFlowOwner((await jarSessions(request)).entries.map((e) => e.user.id));
  const { user, as } = await flowAccount(request, owner);
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  const go = (outcome: string) => new Response(null, { status: 303, headers: { ...headers, Location: `${appUrl(request)}/?connect=${outcome}${as}` } });
  if (!user || !githubReady()) return go("failed");
  if (await overLimit(`connect-callback:${user.id}`, 30, 15 * 60_000)) return go("failed");
  const done = await finishGithub(
    user.id,
    { state: params.get("state"), code: params.get("code"), error: params.get("error"), installationId: params.get("installation_id") },
    appUrl(request),
  ).catch((err) => {
    console.error("[flash] the GitHub sign-in failed", err instanceof Error ? err.name : "error");
    return { outcome: "failed" as const };
  });
  if ("redirect" in done) return new Response(null, { status: 303, headers: { ...headers, Location: done.redirect } });
  return go(done.outcome);
}
