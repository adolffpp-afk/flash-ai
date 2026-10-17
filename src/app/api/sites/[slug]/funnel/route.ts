import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { funnelCalls, funnelRange, funnelStats } from "@/lib/server/funnel.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { overLimit } from "@/lib/server/limits.ts";

export const dynamic = "force-dynamic";

const HOUR = 3600_000;

/**
 * The owner's funnel for one published app (?days=7, 30 or 90; anything else is 30): from visit
 * to sale, per source. Limited per owner, since a long range of a busy app reads many rows.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/funnel">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (await overLimit(`funnel:${user.id}`, funnelCalls(), HOUR)) {
    return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  }
  const { slug } = await ctx.params;
  const stats = (await ownsSite(user.id, slug)) ? await funnelStats(slug, funnelRange(new URL(request.url).searchParams.get("days"))) : null;
  if (!stats) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(stats);
}
