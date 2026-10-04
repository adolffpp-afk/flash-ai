import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { isVerified } from "./account.ts";
import { overLimit } from "./limits.ts";
import type { User } from "./auth.ts";

export const MAX_HTML = 2 * 1024 * 1024;
// Published apps are public pages on Flash's domain, so publishing is limited to slow abuse.
export const MAX_SITES_PER_USER = 20;
const HOUR = 3600_000;
// Earlier versions kept per site, newest first; older ones are deleted.
export const MAX_VERSIONS = 10;

function makeSlug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "app";
  return `${base}-${randomId(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

export async function listSites(userId: string) {
  return all<{ slug: string; title: string; updated_at: number }>(
    "SELECT slug, title, updated_at FROM sites WHERE user_id = ? ORDER BY updated_at DESC",
    [userId],
  );
}

export type PublishResult = { slug: string; url: string } | { error: string; status: number; code?: string };

/** Publishes an app, or updates an already published one when its slug is passed. */
export async function publishSite(user: User, input: { html?: unknown; title?: unknown; slug?: unknown }): Promise<PublishResult> {
  const html = typeof input.html === "string" ? input.html : "";
  const title = (typeof input.title === "string" ? input.title : "My app").trim().slice(0, 100) || "My app";
  const slug = typeof input.slug === "string" ? input.slug : "";
  if (!html.trim()) return { error: "Nothing to publish.", status: 400 };
  if (html.length > MAX_HTML) return { error: "This app is too large to publish (2 MB max).", status: 413 };
  if (!isVerified(user)) return { error: "Confirm your email to publish apps.", status: 403, code: "unverified" };

  if (slug) {
    if (await overLimit(`republish:${user.id}`, 60, HOUR)) return { error: "Too many updates. Try again in an hour.", status: 429 };
    await saveVersion(slug, user.id, html);
    const r = await run("UPDATE sites SET html = ?, title = ?, updated_at = ? WHERE slug = ? AND user_id = ?", [
      html,
      title,
      now(),
      slug,
      user.id,
    ]);
    if (r.rowsAffected) return { slug, url: `/p/${slug}` };
  }
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?", [user.id]);
  if (Number(count?.n ?? 0) >= MAX_SITES_PER_USER) {
    return { error: `You can publish up to ${MAX_SITES_PER_USER} apps. Unpublish one to publish another.`, status: 409 };
  }
  if (await overLimit(`publish:${user.id}`, 10, HOUR)) return { error: "You've published a lot this hour. Try again later.", status: 429 };
  let fresh = makeSlug(title);
  while (await one("SELECT 1 FROM sites WHERE slug = ?", [fresh])) fresh = makeSlug(title);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
    fresh,
    user.id,
    title,
    html,
    now(),
    now(),
  ]);
  return { slug: fresh, url: `/p/${fresh}` };
}

/** The owner's chat that built a site: the newest project with a reply published as it, if any. */
export async function projectForSite(userId: string, slug: string): Promise<string | null> {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  // Published replies keep their site's slug in the saved messages (see AppPreview).
  const row = await one<{ id: string }>(
    "SELECT id FROM projects WHERE user_id = ? AND instr(messages, ?) > 0 ORDER BY updated_at DESC LIMIT 1",
    [userId, `"slug":"${slug}"`],
  );
  return row?.id ?? null;
}

/**
 * Keeps the site as it is now as an earlier version, before it's replaced by `next`. Nothing is
 * kept when the site isn't the user's or wouldn't change.
 */
async function saveVersion(slug: string, userId: string, next: string): Promise<void> {
  const current = await one<{ title: string; html: string; updated_at: number }>(
    "SELECT title, html, updated_at FROM sites WHERE slug = ? AND user_id = ?",
    [slug, userId],
  );
  if (!current || current.html === next) return;
  await run("INSERT INTO site_versions (id, site_slug, title, html, created_at) VALUES (?, ?, ?, ?, ?)", [
    randomId(),
    slug,
    current.title,
    current.html,
    Number(current.updated_at),
  ]);
  await run(
    `DELETE FROM site_versions WHERE site_slug = ? AND id NOT IN
       (SELECT id FROM site_versions WHERE site_slug = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    [slug, slug, MAX_VERSIONS],
  );
}

export type SiteVersion = { id: string; title: string; createdAt: number; size: number };

/** A site's earlier versions, newest first, with when each went live. */
export async function listVersions(slug: string): Promise<SiteVersion[]> {
  const rows = await all<{ id: string; title: string; created_at: number; size: number }>(
    "SELECT id, title, created_at, length(html) AS size FROM site_versions WHERE site_slug = ? ORDER BY created_at DESC, rowid DESC",
    [slug],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: Number(r.created_at), size: Number(r.size) }));
}

/** One earlier version's page, for its owner to look at before bringing it back. */
export async function versionHtml(slug: string, id: string): Promise<string | null> {
  return (await one<{ html: string }>("SELECT html FROM site_versions WHERE site_slug = ? AND id = ?", [slug, id]))?.html ?? null;
}

/** Puts an earlier version live again. The version it replaces is kept, so this can be undone. */
export async function restoreVersion(userId: string, slug: string, id: string): Promise<boolean> {
  const version = await one<{ title: string; html: string }>("SELECT title, html FROM site_versions WHERE site_slug = ? AND id = ?", [slug, id]);
  if (!version) return false;
  await saveVersion(slug, userId, version.html);
  const r = await run("UPDATE sites SET html = ?, title = ?, updated_at = ? WHERE slug = ? AND user_id = ?", [
    version.html,
    version.title,
    now(),
    slug,
    userId,
  ]);
  // It's live now, so it leaves the list; the version it replaced took its place there.
  if (r.rowsAffected) await run("DELETE FROM site_versions WHERE site_slug = ? AND id = ?", [slug, id]);
  return r.rowsAffected > 0;
}
