import { appUrl, getUser } from "@/lib/server/auth.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { githubReady } from "@/lib/server/github.ts";
import { finishGithub } from "@/lib/server/connections.ts";

/*
 * The GitHub App's callback URL: where GitHub sends the browser after the authorize step, and after
 * the app is installed. A code is redeemed only with the state of this signed-in user's own authorize
 * step (see finishGithub); anything else redeems nothing. A token that sees no installation goes on to
 * the installation page, and an installation that came back without Flash's state goes on to the
 * authorize step again. The page it goes back to says only how it ended, in
 * Flash's own words: never GitHub's error text, the code or a token, and the code isn't passed on as a
 * referrer. It costs nothing.
 */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  const go = (outcome: string) => new Response(null, { status: 303, headers: { ...headers, Location: `${appUrl(request)}/?connect=${outcome}` } });
  const user = await getUser(request);
  if (!user || !githubReady()) return go("failed");
  if (await overLimit(`connect-callback:${user.id}`, 30, 15 * 60_000)) return go("failed");
  const params = new URL(request.url).searchParams;
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
