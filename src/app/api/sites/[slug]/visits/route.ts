import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { visitStats } from "@/lib/server/visits.ts";

export const dynamic = "force-dynamic";

/** The owner's visitor stats for one published site: the last 30 days. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/visits">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(await visitStats(slug));
}
