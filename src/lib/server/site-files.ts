/*
 * Files people send to a published app: a photo with a review, a CV with an application, a picture
 * for a listing. The app calls flashDB.upload(file) and gets back a link it can show or save in a
 * record. The files belong to the app, so unpublishing it takes them with it. Anyone with a file's
 * link can open it, so an app takes files only once its owner turns that on.
 */
import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { infectedFile } from "./virus-scan.ts";
import { activeSubscription } from "./subscriptions.ts";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_SITE = 500;
export const MAX_BYTES_PER_SITE = 100 * 1024 * 1024;

/*
 * Files are kept in Flash's database, which bills by the gigabyte, and no credit pays for that. So
 * all of an owner's apps together hold at most their plan's room: 100 MB on the free plan, more on
 * paid plans, whatever each app's own limit. Their assistants' files count against the same room,
 * each at STORE_FACTOR times its text's bytes (see assistants.ts), so the two share it.
 */
const MB = 1024 * 1024;
export const FREE_STORAGE_BYTES = 100 * MB;
export const PLAN_STORAGE_BYTES: Record<string, number> = {
  lite: 1024 * MB,
  pro: 2048 * MB,
  power: 2048 * MB,
  max: 10240 * MB,
  business: 10240 * MB,
  agency: 10240 * MB,
};

/** How many bytes of files all of a user's apps and assistants may hold together, by their plan. */
export async function storageLimit(userId: string): Promise<number> {
  const sub = await activeSubscription(userId);
  return sub && Object.hasOwn(PLAN_STORAGE_BYTES, sub.plan) ? PLAN_STORAGE_BYTES[sub.plan] : FREE_STORAGE_BYTES;
}

/**
 * What a user's files take of their storage, in SQL with the user's id twice: the files all their
 * apps hold, and their assistants' text as it's counted (the stored column, STORE_FACTOR times its
 * bytes). For a check that must hold in the same statement as a write.
 */
export const USED_STORAGE_SQL =
  "((SELECT COALESCE(SUM(u.size), 0) FROM site_uploads u JOIN sites s ON s.slug = u.site_slug WHERE s.user_id = ?) + (SELECT COALESCE(SUM(f.stored), 0) FROM assistant_files f JOIN assistants a ON a.id = f.assistant_id WHERE a.user_id = ?))";

/** The bytes a user's files take of their storage: their apps' files and their assistants' text (see USED_STORAGE_SQL). */
export async function usedStorage(userId: string): Promise<number> {
  const row = await one<{ bytes: number }>(`SELECT ${USED_STORAGE_SQL} AS bytes`, [userId, userId]);
  return Number(row?.bytes ?? 0);
}

// What an app may take: pictures, documents and plain text. Nothing that runs.
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
};

export type UploadResult = { status: number; body: { url: string; name: string; size: number } | { error: string } };

const fail = (error: string, status: number): UploadResult => ({ status, body: { error } });

/** A safe, recognisable name for an uploaded file. */
export function cleanName(name: string, mime: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[^\w. -]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const ext = TYPES[mime];
  if (!base) return `file.${ext}`;
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/** Takes one file from an app's visitor. `owner` is the signed-in person, or "" for anyone. */
export async function saveUpload(
  slug: string,
  file: { name: string; type: string; bytes: Buffer },
  owner: string,
): Promise<UploadResult> {
  if (!TYPES[file.type]) return fail("Apps can take pictures, PDFs and text files.", 415);
  if (!file.bytes.length) return fail("That file is empty.", 400);
  if (file.bytes.length > MAX_UPLOAD_BYTES) return fail("Files must be 5 MB or smaller.", 413);
  const site = await one<{ uploads_on: number; user_id: string }>("SELECT uploads_on, user_id FROM sites WHERE slug = ?", [slug]);
  if (!site) return fail("App not found.", 404);
  if (!Number(site.uploads_on)) {
    return fail("This app isn't taking files yet. Its owner can turn that on in Flash, in My websites & apps > Files.", 403);
  }
  const use = await one<{ n: number; bytes: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM site_uploads WHERE site_slug = ?",
    [slug],
  );
  const full =
    Number(use?.n ?? 0) >= MAX_FILES_PER_SITE ||
    Number(use?.bytes ?? 0) + file.bytes.length > MAX_BYTES_PER_SITE ||
    (await usedStorage(site.user_id)) + file.bytes.length > (await storageLimit(site.user_id));
  if (full) {
    return fail("This app can't hold more files. Its owner can remove some in Flash.", 507);
  }
  const name = cleanName(file.name, file.type);
  if (await infectedFile([{ name, bytes: file.bytes }])) return fail("This file contains a virus, so the app can't take it.", 422);
  const id = randomId(12);
  // INSERT … SELECT, so a file sent just as the app is unpublished, or as its owner turns files off, isn't kept.
  const r = await run(
    "INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) SELECT ?, slug, ?, ?, ?, ?, ?, ? FROM sites WHERE slug = ? AND uploads_on = 1",
    [id, owner, file.type, name, file.bytes, file.bytes.length, now(), slug],
  );
  if (!r.rowsAffected) return fail("App not found.", 404);
  return { status: 201, body: { url: `/api/sites/${slug}/files/${id}`, name, size: file.bytes.length } };
}

/** A file sent to an app, while the app is still published. */
export async function readUpload(slug: string, id: string) {
  return one<{ mime: string; name: string; data: ArrayBuffer }>(
    "SELECT u.mime, u.name, u.data FROM site_uploads u JOIN sites s ON s.slug = u.site_slug WHERE u.site_slug = ? AND u.id = ?",
    [slug, id],
  );
}

export type UploadSummary = { id: string; name: string; mime: string; size: number; createdAt: number; url: string };

/** What an app holds, newest first, for its owner. */
export async function listUploads(slug: string, limit = 200): Promise<UploadSummary[]> {
  const rows = await all<{ id: string; name: string; mime: string; size: number; created_at: number }>(
    "SELECT id, name, mime, size, created_at FROM site_uploads WHERE site_slug = ? ORDER BY created_at DESC LIMIT ?",
    [slug, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: Number(r.size),
    createdAt: Number(r.created_at),
    url: `/api/sites/${slug}/files/${r.id}`,
  }));
}

/** Whether the app takes files from the people using it. */
export async function uploadsOn(slug: string): Promise<boolean> {
  return Boolean(Number((await one<{ uploads_on: number }>("SELECT uploads_on FROM sites WHERE slug = ?", [slug]))?.uploads_on));
}

/** The owner lets the app take files, or stops it. Files already sent stay until deleted. */
export async function setUploadsOn(slug: string, on: boolean): Promise<boolean> {
  await run("UPDATE sites SET uploads_on = ? WHERE slug = ?", [on ? 1 : 0, slug]);
  return uploadsOn(slug);
}

export async function deleteUpload(slug: string, id: string): Promise<boolean> {
  return (await run("DELETE FROM site_uploads WHERE site_slug = ? AND id = ?", [slug, id])).rowsAffected > 0;
}

/**
 * How much room an app's files take, for its owner. maxBytes is the most this app can hold now:
 * its own limit, or less when the owner's other apps use most of their plan's room.
 */
export async function uploadUse(slug: string): Promise<{ files: number; bytes: number; maxFiles: number; maxBytes: number }> {
  const use = await one<{ n: number; bytes: number; user_id: string | null }>(
    "SELECT COUNT(u.id) AS n, COALESCE(SUM(u.size), 0) AS bytes, s.user_id FROM sites s LEFT JOIN site_uploads u ON u.site_slug = s.slug WHERE s.slug = ?",
    [slug],
  );
  const bytes = Number(use?.bytes ?? 0);
  const room = use?.user_id ? (await storageLimit(use.user_id)) - (await usedStorage(use.user_id)) + bytes : MAX_BYTES_PER_SITE;
  return {
    files: Number(use?.n ?? 0),
    bytes,
    maxFiles: MAX_FILES_PER_SITE,
    maxBytes: Math.max(bytes, Math.min(MAX_BYTES_PER_SITE, room)),
  };
}
