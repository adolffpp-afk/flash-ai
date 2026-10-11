import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { connectorsReady } from "@/lib/server/secret-box.ts";
import { ConnectError, problemText, startSignIn } from "@/lib/server/connections.ts";
import { approvalAllowed } from "@/lib/server/pending-actions.ts";

/*
 * Connect (sign in) for a connector: a preset that signs in, a server the user added that asked for a
 * sign-in, or Reconnect. Answers with the authorization server's page, which the page then opens (an
 * https address that isn't one of Flash's own, see checkAuthorizeUrl). It stores a sign-in flow and
 * may register Flash with that server, so like an approval it is taken only from Flash's own page,
 * with its exact Origin (S-3), and only from an account whose email is confirmed. It costs nothing.
 */

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const origin = appUrl(request);
  if (!approvalAllowed(request, [new URL(origin).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  }
  if (!connectorsReady()) return Response.json({ error: t("Connectors aren't set up yet.") }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const url = await startSignIn(
      user.id,
      {
        provider: text(body.provider, 40),
        url: text(body.url, 2000),
        label: text(body.label, 60),
        connectionId: text(body.connectionId, 40),
        clientId: text(body.clientId, 600),
        clientSecret: text(body.clientSecret, 2100),
      },
      origin,
    );
    return Response.json({ url }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof ConnectError) {
      const status = err.code === "limit" ? 429 : err.code === "too_many" ? 409 : err.code === "unverified" ? 403 : err.code === "gone" ? 404 : 400;
      return Response.json({ error: problemText(err.code, t), code: err.code }, { status });
    }
    console.error("[flash] starting a connector sign-in failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500 });
  }
}
