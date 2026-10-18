import { after } from "next/server";
import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { publishSite, siteLimit, unpublishSite } from "@/lib/server/sites.ts";
import { ownsSite, siteCounts, sitesWithMessages } from "@/lib/server/inbox.ts";
import { domainsForSite, removeDomain } from "@/lib/server/domains.ts";
import { refreshStale } from "@/lib/server/seo.ts";

export const dynamic = "force-dynamic";

/**
 * The user's apps, with how many they may publish (maxSites). The list counts messages, visits,
 * members and contacts, and gives search check scores, for its 20 most recently updated apps;
 * ?counts=a,b,… gives those of up to 20 more, when the list shows them.
 */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const asked = new URL(request.url).searchParams.get("counts");
  if (asked !== null) {
    const counts = await siteCounts(user.id, asked.split(",").filter(Boolean).slice(0, 20));
    // Apps published before the search check existed get theirs after this answer, as below.
    const stale = Object.keys(counts).filter((slug) => counts[slug].seo === null);
    if (stale.length) after(() => refreshStale(user.id, stale));
    return Response.json({ counts });
  }
  const [sites, maxSites] = await Promise.all([sitesWithMessages(user.id), siteLimit(user)]);
  // Apps published before the search check existed get theirs after this answer: the next look shows
  // them. Only the apps the list counted have a score (null when there's none yet).
  if (sites.some((s) => s.seo === null)) after(() => refreshStale(user.id));
  return Response.json({ sites, maxSites });
}

/** Publishes an app, or updates an already published one when its slug is passed. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const body = (await request.json().catch(() => ({}))) as { html?: string; title?: string; slug?: string };
  const result = await publishSite(user, body, t);
  if ("error" in result) {
    return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  }
  return Response.json(result);
}

export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  // Its domains leave Vercel too, before the site and everything it kept go.
  if (await ownsSite(user.id, slug)) for (const domain of await domainsForSite(slug)) await removeDomain(domain);
  await unpublishSite(user.id, slug);
  return Response.json({ ok: true });
}
