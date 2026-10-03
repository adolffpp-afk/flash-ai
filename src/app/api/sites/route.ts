import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { all, one, run, now } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";
import { isVerified } from "@/lib/server/account.ts";
import { overLimit } from "@/lib/server/limits.ts";

export const dynamic = "force-dynamic";

const MAX_HTML = 2 * 1024 * 1024;
// Published apps are public pages on Flash's domain, so publishing is limited to slow abuse.
const MAX_SITES_PER_USER = 20;
const HOUR = 3600_000;

function makeSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "app";
  return `${base}-${randomId(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const sites = await all("SELECT slug, title, updated_at FROM sites WHERE user_id = ? ORDER BY updated_at DESC", [
    user.id,
  ]);
  return Response.json({ sites });
}

/** Publishes an app, or updates an already published one when its slug is passed. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { html?: string; title?: string; slug?: string };
  const html = body.html ?? "";
  const title = (body.title ?? "My app").trim().slice(0, 100) || "My app";
  if (!html.trim()) return Response.json({ error: "Nothing to publish." }, { status: 400 });
  if (html.length > MAX_HTML) return Response.json({ error: "This app is too large to publish (2 MB max)." }, { status: 413 });
  if (!isVerified(user)) {
    return Response.json({ error: "Confirm your email to publish apps.", code: "unverified" }, { status: 403 });
  }

  if (body.slug) {
    if (await overLimit(`republish:${user.id}`, 60, HOUR)) {
      return Response.json({ error: "Too many updates. Try again in an hour." }, { status: 429 });
    }
    const r = await run("UPDATE sites SET html = ?, title = ?, updated_at = ? WHERE slug = ? AND user_id = ?", [
      html,
      title,
      now(),
      body.slug,
      user.id,
    ]);
    if (r.rowsAffected) return Response.json({ slug: body.slug, url: `/p/${body.slug}` });
  }
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?", [user.id]);
  if (Number(count?.n ?? 0) >= MAX_SITES_PER_USER) {
    return Response.json(
      { error: `You can publish up to ${MAX_SITES_PER_USER} apps. Unpublish one to publish another.` },
      { status: 409 },
    );
  }
  if (await overLimit(`publish:${user.id}`, 10, HOUR)) {
    return Response.json({ error: "You've published a lot this hour. Try again later." }, { status: 429 });
  }
  let slug = makeSlug(title);
  while (await one("SELECT 1 FROM sites WHERE slug = ?", [slug])) slug = makeSlug(title);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
    slug,
    user.id,
    title,
    html,
    now(),
    now(),
  ]);
  return Response.json({ slug, url: `/p/${slug}` });
}

export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  await run("DELETE FROM sites WHERE slug = ? AND user_id = ?", [slug, user.id]);
  return Response.json({ ok: true });
}
