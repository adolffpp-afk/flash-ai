import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { overLimit } from "./limits.ts";
import { EMAILS, sendEmail } from "./email.ts";

const FORM = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_MESSAGE_BYTES = 16 * 1024;
// Old messages go once a site holds this many, so a spammed form can't grow without end.
const MAX_MESSAGES_PER_SITE = 2000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type SiteMessage = { id: string; form: string; data: Record<string, unknown>; createdAt: number; read: boolean };

/** One line per field, for the email preview. */
function preview(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n")
    .slice(0, 600);
}

/**
 * Saves a form a visitor sent from a published site, for its owner only, and emails the owner
 * (at most 20 emails per site a day). Visitors are limited per address and per site.
 */
export async function receiveMessage(
  slug: string,
  input: { form?: unknown; data?: unknown },
  ip: string,
  origin: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const form = typeof input.form === "string" ? input.form : "";
  if (!FORM.test(form)) return { error: "Invalid form name.", status: 400 };
  const data = input.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "Send the form's fields as an object.", status: 400 };
  const text = JSON.stringify(data);
  if (text.length > MAX_MESSAGE_BYTES) return { error: "That message is too long.", status: 413 };
  if ((await overLimit(`inbox-ip:${ip}`, 10, HOUR)) || (await overLimit(`inbox-site:${slug}`, 300, DAY))) {
    return { error: "Too many messages. Please try again later.", status: 429 };
  }
  const site = await one<{ title: string; email: string }>(
    "SELECT s.title, u.email FROM sites s JOIN users u ON u.id = s.user_id WHERE s.slug = ?",
    [slug],
  );
  if (!site) return { error: "Site not found.", status: 404 };
  await run("INSERT INTO site_messages (id, site_slug, form, data, created_at) VALUES (?, ?, ?, ?, ?)", [randomId(), slug, form, text, now()]);
  await run(
    `DELETE FROM site_messages WHERE site_slug = ? AND id NOT IN
       (SELECT id FROM site_messages WHERE site_slug = ? ORDER BY created_at DESC LIMIT ?)`,
    [slug, slug, MAX_MESSAGES_PER_SITE],
  );
  if (!(await overLimit(`inbox-mail:${slug}`, 20, DAY))) {
    await sendEmail(site.email, EMAILS.siteMessage(site.title, preview(data as Record<string, unknown>), `${origin}/?apps=1`)).catch((err) =>
      console.error("[flash] site message email failed", err),
    );
  }
  return { ok: true };
}

/** Whether the user owns the site. */
export async function ownsSite(userId: string, slug: string): Promise<boolean> {
  return Boolean(await one("SELECT 1 FROM sites WHERE slug = ? AND user_id = ?", [slug, userId]));
}

/** A site's messages, newest first, and marks them read. */
export async function readMessages(slug: string, markRead = true): Promise<SiteMessage[]> {
  const rows = await all<{ id: string; form: string; data: string; created_at: number; read_at: number }>(
    "SELECT id, form, data, created_at, read_at FROM site_messages WHERE site_slug = ? ORDER BY created_at DESC LIMIT 500",
    [slug],
  );
  if (markRead) await run("UPDATE site_messages SET read_at = ? WHERE site_slug = ? AND read_at = 0", [now(), slug]);
  return rows.map((r) => ({ id: r.id, form: r.form, data: JSON.parse(r.data), createdAt: Number(r.created_at), read: Boolean(r.read_at) }));
}

export async function deleteMessage(slug: string, id: string): Promise<void> {
  await run("DELETE FROM site_messages WHERE site_slug = ? AND id = ?", [slug, id]);
}

/** The user's published sites with how many messages each has, and how many are unread. */
export async function sitesWithMessages(userId: string) {
  const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const rows = await all<{ slug: string; title: string; updated_at: number; messages: number; unread: number; views: number }>(
    `SELECT s.slug, s.title, s.updated_at,
            (SELECT COUNT(*) FROM site_messages m WHERE m.site_slug = s.slug) AS messages,
            (SELECT COUNT(*) FROM site_messages m WHERE m.site_slug = s.slug AND m.read_at = 0) AS unread,
            (SELECT COALESCE(SUM(v.views), 0) FROM site_visits v WHERE v.site_slug = s.slug AND v.day >= ?) AS views
     FROM sites s WHERE s.user_id = ? ORDER BY s.updated_at DESC`,
    [since, userId],
  );
  return rows.map((r) => ({
    ...r,
    updated_at: Number(r.updated_at),
    messages: Number(r.messages),
    unread: Number(r.unread),
    views: Number(r.views),
  }));
}

/** A site's form messages as spreadsheet rows: date, form, then one column per field name. */
export function messageRows(messages: SiteMessage[]): unknown[][] {
  const fields = [...new Set(messages.flatMap((m) => Object.keys(m.data)))].slice(0, 50);
  return [
    ["Date", "Form", ...fields],
    ...messages.map((m) => [
      new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " "),
      m.form,
      ...fields.map((f) => {
        const v = m.data[f];
        return typeof v === "string" || v === undefined ? v : JSON.stringify(v);
      }),
    ]),
  ];
}
