import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { countOf } from "@/lib/server/limits.ts";
import { seoReport } from "@/lib/server/seo.ts";
import { pagespeedAvailable, parseRecord, runLock } from "@/lib/server/pagespeed.ts";
import { preferredDomain } from "@/lib/seo-rules.ts";

export const dynamic = "force-dynamic";

/**
 * The app's search check (SEO) for its owner: what was read from its live page and what to fix
 * (see seo-rules.ts). It reads Flash's own copy of the page and calls nothing, so it's free. With it,
 * the last Google PageSpeed Insights check (see the pagespeed route): whether it's about an earlier
 * version, whether Google is taking checks now, and whether one is running.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/seo">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  const site = await one<{ slug: string; title: string; seo: string; updated_at: number; pagespeed: string }>(
    "SELECT slug, title, seo, updated_at, pagespeed FROM sites WHERE slug = ? AND user_id = ?",
    [slug, user.id],
  );
  if (!site) return Response.json({ error: t("Not found") }, { status: 404 });
  const { checkedAt, ctx: context, report } = await seoReport(site);
  const pagespeed = parseRecord(site.pagespeed);
  return Response.json({
    checkedAt,
    title: site.title,
    ctx: context,
    report,
    pagespeed,
    pagespeedStale: pagespeed !== null && pagespeed.for !== checkedAt,
    pagespeedAvailable: await pagespeedAvailable(),
    pagespeedRunning: (await countOf(runLock(site.slug))) > 0,
    domainTest: preferredDomain(context.domains) || null,
  });
}
