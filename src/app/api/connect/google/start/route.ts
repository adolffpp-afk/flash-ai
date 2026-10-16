import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { googleReady } from "@/lib/server/google.ts";
import { ConnectError, problemText, startGoogle } from "@/lib/server/connections.ts";
import { approvalAllowed } from "@/lib/server/pending-actions.ts";

/*
 * Connect Google Drive, or Reconnect it ({ connectionId }), see google.ts: answers with Google's
 * authorize page, which the page then opens. It stores a flow, so like an approval it is taken only
 * from Flash's own page, with its exact Origin (S-3), and only from an account whose email is
 * confirmed. Until Flash's Google Cloud project is set up (and CONNECTOR_KEYS), there is no Google
 * Drive here at all (404). It costs nothing.
 */
export async function POST(request: Request) {
  const headers = { "cache-control": "no-store" };
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const origin = appUrl(request);
  if (!approvalAllowed(request, [new URL(origin).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403, headers });
  }
  if (!googleReady()) return Response.json({ error: t("Not found") }, { status: 404, headers });
  const body = (await request.json().catch(() => ({}))) as { connectionId?: unknown };
  try {
    const url = await startGoogle(user.id, { connectionId: typeof body.connectionId === "string" ? body.connectionId.slice(0, 40) : undefined }, origin);
    return Response.json({ url }, { headers });
  } catch (err) {
    if (err instanceof ConnectError) {
      const status = err.code === "limit" ? 429 : err.code === "too_many" ? 409 : err.code === "unverified" ? 403 : err.code === "gone" ? 404 : 400;
      return Response.json({ error: problemText(err.code, t), code: err.code }, { status, headers });
    }
    console.error("[flash] starting the Google sign-in failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500, headers });
  }
}
