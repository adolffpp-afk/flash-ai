import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { setShowcase } from "@/lib/server/showcase.ts";

export const dynamic = "force-dynamic";

/** The owner offers a picture for the "Made with Flash" showcase ({ on: true }) or takes it back. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/files/[id]/showcase">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== "boolean") return Response.json({ error: t("Say whether it's on.") }, { status: 400 });
  const setting = await setShowcase(user, "picture", id, body.on);
  if (!setting) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(setting);
}
