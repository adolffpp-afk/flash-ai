import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { madeWithFor, setMadeWith } from "@/lib/server/made-with.ts";

export const dynamic = "force-dynamic";

/** Whether this app's link preview says "Made with Flash ∞ AI", and whether the owner's plan lets them turn it off. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/made-with">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  const setting = await madeWithFor(user, slug);
  if (!setting) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(setting);
}

/** The owner turns it on or off. Paid plans only (see made-with.ts); it costs nothing. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/made-with">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await madeWithFor(user, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== "boolean") return Response.json({ error: t("Say whether it's on.") }, { status: 400 });
  const result = await setMadeWith(user, slug, body.on, t);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
