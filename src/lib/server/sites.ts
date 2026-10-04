import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { isVerified } from "./account.ts";
import { overLimit } from "./limits.ts";
import type { User } from "./auth.ts";

export const MAX_HTML = 2 * 1024 * 1024;
// Published apps are public pages on Flash's domain, so publishing is limited to slow abuse.
export const MAX_SITES_PER_USER = 20;
const HOUR = 3600_000;

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
