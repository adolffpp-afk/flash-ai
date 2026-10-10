/*
 * Files people send to a published app: a photo with a review, a CV with an application, a picture
 * for a listing. The app calls flashDB.upload(file) and gets back a link it can show or save in a
 * record. The files belong to the app, so unpublishing it takes them with it. Anyone with a file's
 * link can open it, so an app takes files only once its owner turns that on.
 */
import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_SITE = 500;
export const MAX_BYTES_PER_SITE = 100 * 1024 * 1024;

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
  const site = await one<{ uploads_on: number }>("SELECT uploads_on FROM sites WHERE slug = ?", [slug]);
  if (!site) return fail("App not found.", 404);
  if (!Number(site.uploads_on)) {
    return fail("This app isn't taking files yet. Its owner can turn that on in Flash, in My websites & apps > Files.", 403);
  }
  const use = await one<{ n: number; bytes: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM site_uploads WHERE site_slug = ?",
    [slug],
  );
  if (Number(use?.n ?? 0) >= MAX_FILES_PER_SITE || Number(use?.bytes ?? 0) + file.bytes.length > MAX_BYTES_PER_SITE) {
    return fail("This app can't hold more files. Its owner can remove some in Flash.", 507);
  }
  const id = randomId(12);
  const name = cleanName(file.name, file.type);
  await run("INSERT INTO site_uploads (id, site_slug, owner, mime, name, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id,
    slug,
    owner,
    file.type,
    name,
    file.bytes,
    file.bytes.length,
    now(),
  ]);
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

/** How much room an app's files take, for its owner. */
export async function uploadUse(slug: string): Promise<{ files: number; bytes: number; maxFiles: number; maxBytes: number }> {
  const use = await one<{ n: number; bytes: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM site_uploads WHERE site_slug = ?",
    [slug],
  );
  return {
    files: Number(use?.n ?? 0),
    bytes: Number(use?.bytes ?? 0),
    maxFiles: MAX_FILES_PER_SITE,
    maxBytes: MAX_BYTES_PER_SITE,
  };
}
