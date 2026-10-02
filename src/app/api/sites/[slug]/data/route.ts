import { all, one, run, now } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";

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

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

type Row = { id: string; data: string; created_at: number; updated_at: number };
const toRecord = (r: Row) => ({ ...JSON.parse(r.data), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at });

async function siteExists(slug: string) {
  return Boolean(await one("SELECT 1 FROM sites WHERE slug = ?", [slug]));
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

export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const collection = new URL(request.url).searchParams.get("collection") ?? "";
  if (!COLLECTION.test(collection)) return json({ error: "Invalid collection name." }, 400);
  if (!(await siteExists(slug))) return json({ error: "App not found." }, 404);
  const rows = await all<Row>(
    "SELECT id, data, created_at, updated_at FROM site_records WHERE site_slug = ? AND collection = ? ORDER BY created_at LIMIT 1000",
    [slug, collection],
  );
  return json({ records: rows.map(toRecord) });
}

export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { collection?: string; data?: unknown };
  if (!COLLECTION.test(body.collection ?? "")) return json({ error: "Invalid collection name." }, 400);
  const data = cleanData(body.data);
  if (!data) return json({ error: "Records must be objects under 64 KB." }, 400);
  if (!(await siteExists(slug))) return json({ error: "App not found." }, 404);
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_records WHERE site_slug = ?", [slug]);
  if (Number(count?.n ?? 0) >= MAX_RECORDS_PER_SITE) return json({ error: "This app's storage is full." }, 507);
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
  const existing = await one<Row>(
    "SELECT id, data, created_at, updated_at FROM site_records WHERE site_slug = ? AND collection = ? AND id = ?",
    [slug, body.collection ?? "", body.id ?? ""],
  );
  if (!existing) return json({ error: "Record not found." }, 404);
  const patch = cleanData(body.data);
  if (!patch) return json({ error: "Records must be objects under 64 KB." }, 400);
  const merged = JSON.stringify({ ...JSON.parse(existing.data), ...JSON.parse(patch) });
  if (merged.length > MAX_RECORD_BYTES) return json({ error: "Records must be under 64 KB." }, 400);
  const updated = now();
  await run("UPDATE site_records SET data = ?, updated_at = ? WHERE id = ?", [merged, updated, existing.id]);
  return json({ record: toRecord({ ...existing, data: merged, updated_at: updated }) });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const q = new URL(request.url).searchParams;
  await run("DELETE FROM site_records WHERE site_slug = ? AND collection = ? AND id = ?", [
    slug,
    q.get("collection") ?? "",
    q.get("id") ?? "",
  ]);
  return json({ ok: true });
}
