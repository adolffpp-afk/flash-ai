import { all, db, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { isVerified } from "./account.ts";
import { overLimit } from "./limits.ts";
import { dataSummary, rulesForPage } from "./site-data.ts";
import type { User } from "./auth.ts";
import type { DataSummary } from "../data-rules.ts";
import { english, type Translate } from "../i18n.ts";

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

// Everything kept for a published site, by its slug. Unpublishing deletes all of it: the database
// doesn't enforce its ON DELETE CASCADE links (Turso runs with foreign keys off), so nothing
// goes on its own. A test checks every table with a site_slug column is here.
export const SITE_TABLES = [
  "site_records",
  "site_users",
  "site_sessions",
  "site_page_tokens",
  "site_ai",
  "site_ai_usage",
  "site_uploads",
  "site_messages",
  "site_domains",
  "site_versions",
  "site_visits",
  "site_visitors",
  "site_products",
  "site_orders",
  "site_owner_keys",
  "site_owner_codes",
  "site_collection_rules",
];
// The ones a new site must never take over from an old site of the same name (records, members,
// files, messages, orders, history, settings, visits and the AI it used today), each looked up by
// an index on site_slug.
const INHERITABLE = [
  "site_records",
  "site_users",
  "site_uploads",
  "site_messages",
  "site_orders",
  "site_products",
  "site_domains",
  "site_versions",
  "site_ai",
  "site_ai_usage",
  "site_visits",
  "site_visitors",
  "site_collection_rules",
];

/** Whether a slug is in use, or still has something left from a site unpublished before everything went with it. */
export async function slugTaken(slug: string): Promise<boolean> {
  const sql = ["SELECT 1 FROM sites WHERE slug = ?", ...INHERITABLE.map((t) => `SELECT 1 FROM ${t} WHERE site_slug = ?`)].join(" UNION ALL ");
  return Boolean(await one(`${sql} LIMIT 1`, Array(INHERITABLE.length + 1).fill(slug)));
}

/** Takes a site offline with everything it kept, in one go. Nothing happens unless it's the user's. */
export async function unpublishSite(userId: string, slug: string): Promise<boolean> {
  const owned = "EXISTS (SELECT 1 FROM sites WHERE slug = ? AND user_id = ?)";
  const results = await (
    await db()
  ).batch(
    [
      ...SITE_TABLES.map((t) => ({ sql: `DELETE FROM ${t} WHERE site_slug = ? AND ${owned}`, args: [slug, slug, userId] })),
      { sql: "DELETE FROM sites WHERE slug = ? AND user_id = ?", args: [slug, userId] },
    ],
    "write",
  );
  return results.at(-1)!.rowsAffected > 0;
}

export async function listSites(userId: string) {
  return all<{ slug: string; title: string; updated_at: number }>(
    "SELECT slug, title, updated_at FROM sites WHERE user_id = ? ORDER BY updated_at DESC",
    [userId],
  );
}

export type PublishResult = { slug: string; url: string; data?: DataSummary } | { error: string; status: number; code?: string };

/**
 * The published site, with who may change its data (see data-rules.ts). before is who could change
 * it before this update. Collections only the owner could see, and visitors can see now, are listed
 * as exposed, whatever made them visible: the new page's block naming them with another rule, its
 * "*" or Flash's guess, or the owner's default for anything else. Only the owner's own choice for
 * a collection in Flash isn't, as they chose it. Collections visitors could add to or change, and
 * now can only read because the new page's flash-data block doesn't name them, are listed as
 * closed. The publish has happened even if that can't be read.
 */
async function published(slug: string, before: DataSummary | null = null): Promise<PublishResult> {
  const data = await dataSummary(slug).catch(() => null);
  if (data && before) {
    const ruleBefore = (name: string) => before.collections.find((c) => c.name === name)?.rule ?? before.other;
    const wasPrivate = (name: string) => before.collections.some((c) => c.name === name && c.rule === "private");
    const exposed = data.collections.filter((c) => c.source !== "you" && c.rule !== "private" && wasPrivate(c.name));
    if (exposed.length) data.exposed = exposed.map((c) => c.name);
    // When the block can't be read at all, what that means for visitors is said already (see blockProblem).
    const unreadable = data.bad && data.bad.why !== "entries";
    const closed = unreadable
      ? []
      : data.collections.filter((c) => c.source === "block" && c.rule === "read" && ruleBefore(c.name) !== "read" && !wasPrivate(c.name)).map((c) => c.name);
    if (closed.length) data.closed = closed;
  }
  return { slug, url: `/p/${slug}`, ...(data && { data }) };
}

/** Publishes an app, or updates an already published one when its slug is passed. */
export async function publishSite(
  user: User,
  input: { html?: unknown; title?: unknown; slug?: unknown },
  t: Translate = english,
): Promise<PublishResult> {
  const html = typeof input.html === "string" ? input.html : "";
  const title = (typeof input.title === "string" ? input.title : "My app").trim().slice(0, 100) || "My app";
  const slug = typeof input.slug === "string" ? input.slug : "";
  if (!html.trim()) return { error: t("Nothing to publish."), status: 400 };
  if (html.length > MAX_HTML) return { error: t("This app is too large to publish (2 MB max)."), status: 413 };
  if (!isVerified(user)) return { error: t("Confirm your email to publish apps."), status: 403, code: "unverified" };

  if (slug) {
    if (await overLimit(`republish:${user.id}`, 60, HOUR)) return { error: t("Too many updates. Try again in an hour."), status: 429 };
    // Who could change the app's data before, to say what this update closes.
    const before = (await one("SELECT 1 FROM sites WHERE slug = ? AND user_id = ?", [slug, user.id])) ? await dataSummary(slug).catch(() => null) : null;
    await saveVersion(slug, user.id, html);
    // The rules the page names are saved with it, so they change together.
    const r = await run("UPDATE sites SET html = ?, title = ?, updated_at = ?, data_rules = ? WHERE slug = ? AND user_id = ?", [
      html,
      title,
      now(),
      await rulesForPage(slug, html),
      slug,
      user.id,
    ]);
    if (r.rowsAffected) return published(slug, before);
  }
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?", [user.id]);
  if (Number(count?.n ?? 0) >= MAX_SITES_PER_USER) {
    return { error: t("You can publish up to {max} apps. Unpublish one to publish another.", { max: MAX_SITES_PER_USER }), status: 409 };
  }
  if (await overLimit(`publish:${user.id}`, 10, HOUR)) return { error: t("You've published a lot this hour. Try again later."), status: 429 };
  let fresh = makeSlug(title);
  while (await slugTaken(fresh)) fresh = makeSlug(title);
  await run("INSERT INTO sites (slug, user_id, title, html, created_at, updated_at, data_rules) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    fresh,
    user.id,
    title,
    html,
    now(),
    now(),
    await rulesForPage(null, html),
  ]);
  return published(fresh);
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
  const r = await run("UPDATE sites SET html = ?, title = ?, updated_at = ?, data_rules = ? WHERE slug = ? AND user_id = ?", [
    version.html,
    version.title,
    now(),
    await rulesForPage(slug, version.html),
    slug,
    userId,
  ]);
  // It's live now, so it leaves the list; the version it replaced took its place there.
  if (r.rowsAffected) await run("DELETE FROM site_versions WHERE site_slug = ? AND id = ?", [slug, id]);
  return r.rowsAffected > 0;
}
