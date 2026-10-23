import { appUrl } from "@/lib/server/auth.ts";
import { guard, problem, readBody, reply, str } from "@/lib/server/social-routes.ts";
import { connectWithKey, networkReady, pickTarget, removeAccount, startSignin } from "@/lib/server/social.ts";
import { isSigninNetwork } from "@/lib/server/social-signin.ts";
import { isNetworkId } from "@/lib/social.ts";

/*
 * Connect an account: X, YouTube, Google Business Profile and Pinterest answer with the network's
 * sign-in page ({ url }), which the page opens; Bluesky, Mastodon and Telegram take what the user
 * made there and answer with the account. PATCH picks where an account posts; DELETE removes it.
 */
export async function POST(request: Request) {
  const g = await guard(request, true);
  if (g instanceof Response) return g;
  const body = await readBody(request);
  const network = body.network;
  if (!isNetworkId(network) || !networkReady(network)) return reply({ error: g.t("Not found") }, 404);
  try {
    if (isSigninNetwork(network)) return reply({ url: await startSignin(g.user.id, network, appUrl(request)) });
    if (network === "bluesky") return reply({ account: await connectWithKey(g.user.id, { network, handle: str(body.handle, 300), password: str(body.password, 100) }) });
    if (network === "mastodon") return reply({ account: await connectWithKey(g.user.id, { network, server: str(body.server, 300), token: str(body.token, 300) }) });
    return reply({ account: await connectWithKey(g.user.id, { network: "telegram", token: str(body.token, 100), chat: str(body.chat, 100) }) });
  } catch (err) {
    return problem(err, g.t, "connect");
  }
}

export async function PATCH(request: Request) {
  const g = await guard(request, true);
  if (g instanceof Response) return g;
  const body = await readBody(request);
  try {
    return reply({ account: await pickTarget(g.user.id, str(body.id, 40), str(body.target, 200)) });
  } catch (err) {
    return problem(err, g.t, "target");
  }
}

export async function DELETE(request: Request) {
  const g = await guard(request, true);
  if (g instanceof Response) return g;
  const body = await readBody(request);
  try {
    await removeAccount(g.user.id, str(body.id, 40));
    return reply({ ok: true });
  } catch (err) {
    return problem(err, g.t, "remove");
  }
}
