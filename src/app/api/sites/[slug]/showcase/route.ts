import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { setShowcase, showcaseFor } from "@/lib/server/showcase.ts";

export const dynamic = "force-dynamic";

/** Whether this app is offered for the "Made with Flash" showcase, and whether it was approved. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/showcase">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  const setting = await showcaseFor(user.id, "site", slug);
  if (!setting) return Response.json({ error: (await translatorFor(request, user.language))("Not found") }, { status: 404 });
  return Response.json(setting);
}

/** The owner offers the app for the showcase ({ on: true }) or takes it back. Free, on every plan. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/showcase">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== "boolean") return Response.json({ error: t("Say whether it's on.") }, { status: 400 });
  const setting = await setShowcase(user, "site", slug, body.on);
  if (!setting) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(setting);
}
