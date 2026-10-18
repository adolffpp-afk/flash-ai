import { appUrl, flowAccount } from "@/lib/server/auth.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { connectorsReady } from "@/lib/server/secret-box.ts";
import { finishSignIn } from "@/lib/server/connections.ts";
import { flowOwner } from "@/lib/server/mcp-oauth.ts";

/*
 * Where an authorization server sends the browser back after a connector sign-in. The flow is taken
 * once, and only by the signed-in user who started it (see takeFlow), before anything is stored; iss
 * must be the server the flow started with. The page it goes back to says only how it ended, in
 * Flash's own words: never the server's error text, the code or a token. It costs nothing. In a
 * browser signed in to several accounts, it is the account that started the sign-in (see flowAccount).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const { user, as } = await flowAccount(request, await flowOwner(params.get("state")));
  const go = (outcome: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${appUrl(request)}/?connect=${outcome}${as}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  if (!user || !connectorsReady()) return go("failed");
  if (await overLimit(`connect-callback:${user.id}`, 30, 15 * 60_000)) return go("failed");
  const outcome = await finishSignIn(user.id, {
    state: params.get("state"),
    code: params.get("code"),
    iss: params.get("iss"),
    error: params.get("error"),
  }).catch((err) => {
    console.error("[flash] a connector sign-in failed", err instanceof Error ? err.name : "error");
    return "failed" as const;
  });
  return go(outcome);
}
