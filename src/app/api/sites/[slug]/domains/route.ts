import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { addDomain, canUseDomains, domainStatus, domainsConfigured, domainsForSite, removeDomain } from "@/lib/server/domains.ts";

export const dynamic = "force-dynamic";

/** The site's custom domains with their status, and whether this user can add one. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/domains">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const domains = domainsConfigured() ? await Promise.all((await domainsForSite(slug)).map(domainStatus)) : [];
  return Response.json({ available: domainsConfigured(), allowed: await canUseDomains(user), domains });
}

export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/domains">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const { domain } = (await request.json().catch(() => ({}))) as { domain?: string };
  const result = await addDomain(user, slug, String(domain ?? ""), t);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ domain: result });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/domains">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const domain = new URL(request.url).searchParams.get("domain") ?? "";
  if ((await domainsForSite(slug)).includes(domain)) await removeDomain(domain);
  return Response.json({ ok: true });
}
