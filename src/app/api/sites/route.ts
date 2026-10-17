import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { publishSite, siteLimit, unpublishSite } from "@/lib/server/sites.ts";
import { ownsSite, siteCounts, sitesWithMessages } from "@/lib/server/inbox.ts";
import { domainsForSite, removeDomain } from "@/lib/server/domains.ts";

export const dynamic = "force-dynamic";

/**
 * The user's apps, with how many they may publish (maxSites). The list counts messages, visits,
 * members and contacts for its 20 most recently updated apps; ?counts=a,b,… gives those of up to 20
 * more, when the list shows them.
 */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const asked = new URL(request.url).searchParams.get("counts");
  if (asked !== null) return Response.json({ counts: await siteCounts(user.id, asked.split(",").filter(Boolean).slice(0, 20)) });
  const [sites, maxSites] = await Promise.all([sitesWithMessages(user.id), siteLimit(user)]);
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
