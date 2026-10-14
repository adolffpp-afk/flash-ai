import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { githubReady } from "@/lib/server/github.ts";
import { ConnectError, problemText, startGithub } from "@/lib/server/connections.ts";
import { approvalAllowed } from "@/lib/server/pending-actions.ts";

/*
 * Connect GitHub, or Reconnect it ({ connectionId }), see github.ts: answers with GitHub's authorize
 * page for the GitHub App, which the page then opens (the installation page follows only when the
 * user has no installation). With { install: true }, for a connected account (Add repositories on
 * GitHub): the app's installation page, with a flow that brings the user back. It stores a flow, so like an
 * approval it is taken only from Flash's own page, with its exact Origin (S-3), and only from an
 * account whose email is confirmed. Until the GitHub App is set up (and CONNECTOR_KEYS), there is no
 * GitHub here at all (404). It costs nothing.
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const origin = appUrl(request);
  if (!approvalAllowed(request, [new URL(origin).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  }
  if (!githubReady()) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { connectionId?: unknown; install?: unknown } | null;
  try {
    const url = await startGithub(
      user.id,
      { connectionId: typeof body?.connectionId === "string" ? body.connectionId.slice(0, 40) : undefined, install: body?.install === true },
      origin,
    );
    return Response.json({ url }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof ConnectError) {
      const status = err.code === "limit" ? 429 : err.code === "too_many" ? 409 : err.code === "unverified" ? 403 : err.code === "gone" ? 404 : 400;
      return Response.json({ error: problemText(err.code, t), code: err.code }, { status });
    }
    console.error("[flash] starting the GitHub sign-in failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500 });
  }
}
