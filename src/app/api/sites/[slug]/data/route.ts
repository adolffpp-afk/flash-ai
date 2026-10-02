import { all, one, run, now } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";

// The public data API behind window.flashDB in published apps. Apps run on an opaque origin,
// so this answers any origin and never uses cookies. Data is shared by everyone using the app.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const COLLECTION = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS_PER_SITE = 5000;
const MAX_BYTES_PER_SITE = 20 * 1024 * 1024;
// A list answer stops after this much data or this many records; the client asks for the rest.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_RECORDS = 1000;
const MINUTE = 60_000;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

type Row = { id: string; data: string; created_at: number; updated_at: number };
const toRecord = (r: Row) => ({ ...JSON.parse(r.data), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at });

async function siteExists(slug: string) {
  return Boolean(await one("SELECT 1 FROM sites WHERE slug = ?", [slug]));
}

/** Anyone can call this API, so each visitor and each app gets a request budget. */
async function limited(request: Request, slug: string): Promise<Response | null> {
  if ((await overLimit(`flashdb-ip:${clientIp(request)}`, 120, MINUTE)) || (await overLimit(`flashdb-site:${slug}`, 1200, MINUTE))) {
    return json({ error: "Too many requests. Please wait a minute." }, 429);
  }
  return null;
}

/** Whether a site has room for `extra` more bytes of data (and one more record when adding). */
async function hasRoom(slug: string, extra: number, adding: boolean): Promise<boolean> {
  const use = await one<{ n: number; bytes: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM site_records WHERE site_slug = ?",
    [slug],
  );
  if (adding && Number(use?.n ?? 0) >= MAX_RECORDS_PER_SITE) return false;
  return Number(use?.bytes ?? 0) + extra <= MAX_BYTES_PER_SITE;
}

function cleanData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  // Flash sets these fields itself, so the app can't overwrite them.
  const rest = { ...(data as Record<string, unknown>) };
  delete rest.id;
  delete rest.createdAt;
  delete rest.updatedAt;
  const text = JSON.stringify(rest);
  return text.length <= MAX_RECORD_BYTES ? text : null;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Lists a collection, oldest first, in pages of up to 2 MB. When more is true, ask again with
 * the returned cursor to get the next page (window.flashDB.list does this itself).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const collection = q.get("collection") ?? "";
  if (!COLLECTION.test(collection)) return json({ error: "Invalid collection name." }, 400);
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  if (!(await siteExists(slug))) return json({ error: "App not found." }, 404);
  // The cursor is the last record's createdAt and id, so records added meanwhile aren't skipped.
  const [afterTime, afterId = ""] = (q.get("cursor") ?? "").split(":");
  const after = Number(afterTime) || 0;
  const rows = await all<Row>(
    `SELECT id, data, created_at, updated_at FROM site_records
     WHERE site_slug = ? AND collection = ? AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at, id LIMIT ?`,
    [slug, collection, after, after, afterId, MAX_PAGE_RECORDS + 1],
  );
  const page: Row[] = [];
  let bytes = 0;
  for (const r of rows.slice(0, MAX_PAGE_RECORDS)) {
    if (page.length && bytes + r.data.length > MAX_PAGE_BYTES) break;
    page.push(r);
    bytes += r.data.length;
  }
  const more = page.length < rows.length;
  const lastRow = page.at(-1);
  return json({
    records: page.map(toRecord),
    more,
    ...(more && lastRow && { cursor: `${lastRow.created_at}:${lastRow.id}` }),
  });
}

export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { collection?: string; data?: unknown };
  if (!COLLECTION.test(body.collection ?? "")) return json({ error: "Invalid collection name." }, 400);
  const data = cleanData(body.data);
  if (!data) return json({ error: "Records must be objects under 64 KB." }, 400);
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  if (!(await siteExists(slug))) return json({ error: "App not found." }, 404);
  if (!(await hasRoom(slug, data.length, true))) return json({ error: "This app's storage is full." }, 507);
  const row: Row = { id: randomId(9), data, created_at: now(), updated_at: now() };
  await run(
    "INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [row.id, slug, body.collection!, data, row.created_at, row.updated_at],
  );
  return json({ record: toRecord(row) }, 201);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { collection?: string; id?: string; data?: unknown };
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const existing = await one<Row>(
    "SELECT id, data, created_at, updated_at FROM site_records WHERE site_slug = ? AND collection = ? AND id = ?",
    [slug, body.collection ?? "", body.id ?? ""],
  );
  if (!existing) return json({ error: "Record not found." }, 404);
  const patch = cleanData(body.data);
  if (!patch) return json({ error: "Records must be objects under 64 KB." }, 400);
  const merged = JSON.stringify({ ...JSON.parse(existing.data), ...JSON.parse(patch) });
  if (merged.length > MAX_RECORD_BYTES) return json({ error: "Records must be under 64 KB." }, 400);
  if (merged.length > existing.data.length && !(await hasRoom(slug, merged.length - existing.data.length, false))) {
    return json({ error: "This app's storage is full." }, 507);
  }
  const updated = now();
  await run("UPDATE site_records SET data = ?, updated_at = ? WHERE id = ?", [merged, updated, existing.id]);
  return json({ record: toRecord({ ...existing, data: merged, updated_at: updated }) });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  await run("DELETE FROM site_records WHERE site_slug = ? AND collection = ? AND id = ?", [
    slug,
    q.get("collection") ?? "",
    q.get("id") ?? "",
  ]);
  return json({ ok: true });
}
