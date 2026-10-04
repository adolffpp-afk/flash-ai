import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { run } from "@/lib/server/db.ts";
import { publishSite } from "@/lib/server/sites.ts";
import { ownsSite, sitesWithMessages } from "@/lib/server/inbox.ts";
import { domainsForSite, removeDomain } from "@/lib/server/domains.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ sites: await sitesWithMessages(user.id) });
}

/** Publishes an app, or updates an already published one when its slug is passed. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { html?: string; title?: string; slug?: string };
  const result = await publishSite(user, body);
  if ("error" in result) {
    return Response.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  }
  return Response.json(result);
}

export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  // Its domains leave Vercel too, before the site (and their rows) go.
  if (await ownsSite(user.id, slug)) for (const domain of await domainsForSite(slug)) await removeDomain(domain);
  await run("DELETE FROM sites WHERE slug = ? AND user_id = ?", [slug, user.id]);
  return Response.json({ ok: true });
}
