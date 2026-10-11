import { fromOwnPage, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { connectorsReady } from "@/lib/server/secret-box.ts";
import { ConnectError, problemText, updateConnection } from "@/lib/server/connections.ts";

/**
 * Changes one tool of the user's connections: on or off, always allowed (a server they added only),
 * or a changed tool looked at again (review).
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/connect/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  if (!connectorsReady()) return Response.json({ error: t("Connectors aren't set up yet.") }, { status: 503 });
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const flag = (key: string) => (typeof body[key] === "boolean" ? (body[key] as boolean) : undefined);
  if (typeof body.tool !== "string") return Response.json({ error: t("Unknown action.") }, { status: 400 });
  try {
    const connection = await updateConnection(user.id, id, {
      tool: body.tool.slice(0, 128),
      enabled: flag("enabled"),
      trusted: flag("trusted"),
      review: flag("review"),
    });
    return Response.json({ connection });
  } catch (err) {
    if (err instanceof ConnectError) {
      return Response.json({ error: problemText(err.code, t), code: err.code }, { status: err.code === "gone" ? 404 : err.code === "limit" ? 429 : 400 });
    }
    console.error("[flash] changing a connector failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500 });
  }
}
