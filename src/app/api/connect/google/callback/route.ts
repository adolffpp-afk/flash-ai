import { appUrl, getUser } from "@/lib/server/auth.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { googleReady } from "@/lib/server/google.ts";
import { finishGoogle } from "@/lib/server/connections.ts";

/*
 * Google's redirect URI: where Google sends the browser after its authorize step. A code is traded
 * only with the state of this signed-in user's own authorize step (see finishGoogle); anything else
 * trades nothing. The scopes Google granted are checked, and the account's label is the email Google
 * confirmed in its own answer. The page it goes back to says only how it ended, in Flash's own
 * words: never Google's error text, the code or a token, and the code isn't passed on as a referrer.
 * It costs nothing.
 */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  const go = (outcome: string) => new Response(null, { status: 303, headers: { ...headers, Location: `${appUrl(request)}/?connect=${outcome}` } });
  const user = await getUser(request);
  if (!user || !googleReady()) return go("failed");
  if (await overLimit(`connect-callback:${user.id}`, 30, 15 * 60_000)) return go("failed");
  const params = new URL(request.url).searchParams;
  const outcome = await finishGoogle(user.id, { state: params.get("state"), code: params.get("code"), error: params.get("error") }).catch((err) => {
    console.error("[flash] the Google sign-in failed", err instanceof Error ? err.name : "error");
    return "failed" as const;
  });
  return go(outcome);
}
