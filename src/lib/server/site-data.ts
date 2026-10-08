/*
 * The records a published app keeps: window.flashDB. Shared records (owner "") are the app's own
 * data, which everyone using it sees. Records with an owner belong to one person signed in to the
 * app (flashDB.mine), and only they can read or change them.
 */
import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";

export const COLLECTION = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS_PER_SITE = 5000;
const MAX_BYTES_PER_SITE = 20 * 1024 * 1024;
// A list answer stops after this much data or this many records; the client asks for the rest.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_RECORDS = 1000;

type Row = { id: string; data: string; created_at: number; updated_at: number };
export type Answer = { status: number; body: unknown };

const toRecord = (r: Row) => ({ ...JSON.parse(r.data), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at });
const fail = (error: string, status: number): Answer => ({ status, body: { error } });

export async function siteExists(slug: string): Promise<boolean> {
  return Boolean(await one("SELECT 1 FROM sites WHERE slug = ?", [slug]));
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

/**
 * Lists a collection, oldest first, in pages of up to 2 MB. When more is true, ask again with the
 * returned cursor (window.flashDB.list does this itself). owner "" is the app's shared records.
 */
export async function listRecords(slug: string, collection: string, cursor: string, owner: string): Promise<Answer> {
  if (!COLLECTION.test(collection)) return fail("Invalid collection name.", 400);
  if (!(await siteExists(slug))) return fail("App not found.", 404);
  // The cursor is the last record's createdAt and id, so records added meanwhile aren't skipped.
  const [afterTime, afterId = ""] = cursor.split(":");
  const after = Number(afterTime) || 0;
  const rows = await all<Row>(
    `SELECT id, data, created_at, updated_at FROM site_records
     WHERE site_slug = ? AND collection = ? AND owner = ? AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at, id LIMIT ?`,
    [slug, collection, owner, after, after, afterId, MAX_PAGE_RECORDS + 1],
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
  return {
    status: 200,
    body: { records: page.map(toRecord), more, ...(more && lastRow && { cursor: `${lastRow.created_at}:${lastRow.id}` }) },
  };
}

export async function addRecord(slug: string, collection: unknown, data: unknown, owner: string): Promise<Answer> {
  if (typeof collection !== "string" || !COLLECTION.test(collection)) return fail("Invalid collection name.", 400);
  const clean = cleanData(data);
  if (!clean) return fail("Records must be objects under 64 KB.", 400);
  if (!(await siteExists(slug))) return fail("App not found.", 404);
  if (!(await hasRoom(slug, clean.length, true))) return fail("This app's storage is full.", 507);
  const row: Row = { id: randomId(9), data: clean, created_at: now(), updated_at: now() };
  await run(
    "INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at, owner) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [row.id, slug, collection, clean, row.created_at, row.updated_at, owner],
  );
  return { status: 201, body: { record: toRecord(row) } };
}

export async function patchRecord(slug: string, collection: unknown, id: unknown, data: unknown, owner: string): Promise<Answer> {
  const existing = await one<Row>(
    "SELECT id, data, created_at, updated_at FROM site_records WHERE site_slug = ? AND collection = ? AND id = ? AND owner = ?",
    [slug, typeof collection === "string" ? collection : "", typeof id === "string" ? id : "", owner],
  );
  if (!existing) return fail("Record not found.", 404);
  const patch = cleanData(data);
  if (!patch) return fail("Records must be objects under 64 KB.", 400);
  const merged = JSON.stringify({ ...JSON.parse(existing.data), ...JSON.parse(patch) });
  if (merged.length > MAX_RECORD_BYTES) return fail("Records must be under 64 KB.", 400);
  if (merged.length > existing.data.length && !(await hasRoom(slug, merged.length - existing.data.length, false))) {
    return fail("This app's storage is full.", 507);
  }
  const updated = now();
  await run("UPDATE site_records SET data = ?, updated_at = ? WHERE id = ?", [merged, updated, existing.id]);
  return { status: 200, body: { record: toRecord({ ...existing, data: merged, updated_at: updated }) } };
}

export async function removeRecord(slug: string, collection: string, id: string, owner: string): Promise<Answer> {
  await run("DELETE FROM site_records WHERE site_slug = ? AND collection = ? AND id = ? AND owner = ?", [slug, collection, id, owner]);
  return { status: 200, body: { ok: true } };
}
