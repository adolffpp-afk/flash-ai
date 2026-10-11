import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { connectorsReady } from "@/lib/server/secret-box.ts";
import { failedText, runApproved } from "@/lib/server/connections.ts";
import { actionStatus, approvalAllowed, cancelAction } from "@/lib/server/pending-actions.ts";

/*
 * Approve or cancel a connector call a reply asked for (see pending-actions.ts). Only from Flash's own
 * page (an exact Origin), with the user's own session, once, for the input the card showed, within 30
 * minutes. Approving runs the call with no model: it costs no credits and starts no reply.
 */

export async function GET(request: Request, ctx: RouteContext<"/api/connect/actions/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const status = await actionStatus(user.id, id);
  const t = await translatorFor(request, user.language);
  if (!status) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(status.status === "failed" && status.result ? { ...status, result: failedText(status.result, t) } : status);
}

export async function POST(request: Request, ctx: RouteContext<"/api/connect/actions/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!approvalAllowed(request, [new URL(appUrl(request)).origin, new URL(request.url).origin])) return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  if (!connectorsReady()) return Response.json({ error: t("Connectors aren't set up yet.") }, { status: 503 });
  if (await overLimit(`approve:${user.id}`, 30, 15 * 60_000)) {
    return Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 });
  }
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { decision?: unknown; inputHash?: unknown };
  if (body.decision === "cancel") {
    return (await cancelAction(user.id, id))
      ? Response.json({ status: "cancelled" })
      : Response.json({ error: t("This was already answered, or it expired.") }, { status: 409 });
  }
  if (body.decision !== "approve" || typeof body.inputHash !== "string") return Response.json({ error: t("Unknown action.") }, { status: 400 });
  const done = await runApproved(user.id, id, body.inputHash);
  if (!done) return Response.json({ error: t("This was already answered, or it expired.") }, { status: 409 });
  return Response.json(done.status === "failed" ? { ...done, result: failedText(done.result, t) } : done);
}
