import { all, one, run, now } from "./db.ts";
import { isAdmin, type User } from "./auth.ts";
import type { ShowcaseKind, ShowcaseList, ShowcaseStatus } from "../showcase.ts";

/*
 * The "Made with Flash" showcase at the foot of the landing page: published apps and pictures their
 * owners offered with "Show in Flash showcase". Offering one only asks: nothing appears until the
 * owner of Flash approves it in the dashboard (Showcase tab), and they can hide it again any time.
 * The owner of the item can take it back the same way they offered it, which removes it at once.
 * Unpublishing an app or deleting a picture removes its row too, and the public list joins the app's
 * or file's own row, so something gone never shows.
 */

export const SHOWCASE_KINDS: ShowcaseKind[] = ["site", "picture"];
export const isShowcaseKind = (k: unknown): k is ShowcaseKind => SHOWCASE_KINDS.includes(k as ShowcaseKind);
const DECISIONS: ShowcaseStatus[] = ["shown", "hidden", "waiting"];
export const isDecision = (s: unknown): s is ShowcaseStatus => DECISIONS.includes(s as ShowcaseStatus);

// How many of each the landing page shows, newest approved first.
const PUBLIC_SITES = 9;
const PUBLIC_PICTURES = 12;

// Only pictures a browser shows as they are (no SVG, which can carry script).
const PICTURE = "f.mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')";

/** Whether the item is the user's: their published app, or one of their pictures. */
async function owns(userId: string, kind: ShowcaseKind, ref: string): Promise<boolean> {
  const sql = kind === "site" ? "SELECT 1 FROM sites WHERE slug = ? AND user_id = ?" : `SELECT 1 FROM files f WHERE f.id = ? AND f.user_id = ? AND ${PICTURE}`;
  return Boolean(await one(sql, [ref, userId]));
}

// on: the owner offered it. status: what the owner of Flash decided ('waiting' until then).
export type ShowcaseSetting = { on: boolean; status: ShowcaseStatus | null };

/** The setting for one of the user's apps or pictures, or null when it isn't theirs. */
export async function showcaseFor(userId: string, kind: ShowcaseKind, ref: string): Promise<ShowcaseSetting | null> {
  if (!(await owns(userId, kind, ref))) return null;
  const row = await one<{ status: ShowcaseStatus }>("SELECT status FROM showcase WHERE kind = ? AND ref = ? AND user_id = ?", [kind, ref, userId]);
  return { on: Boolean(row), status: row?.status ?? null };
}

/**
 * The owner offers an item or takes it back. Offering waits for approval, except the owner of Flash's
 * own, which shows at once. Offering again what was already offered changes nothing (a hidden item
 * stays hidden). Null when the item isn't theirs.
 */
export async function setShowcase(user: Pick<User, "id" | "email" | "verified_at">, kind: ShowcaseKind, ref: string, on: boolean): Promise<ShowcaseSetting | null> {
  if (!(await owns(user.id, kind, ref))) return null;
  if (!on) await run("DELETE FROM showcase WHERE kind = ? AND ref = ? AND user_id = ?", [kind, ref, user.id]);
  else {
    const admin = isAdmin(user);
    await run(
      "INSERT INTO showcase (kind, ref, user_id, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, ref) DO NOTHING",
      [kind, ref, user.id, admin ? "shown" : "waiting", now(), admin ? now() : 0],
    );
  }
  return showcaseFor(user.id, kind, ref);
}

/** Removes an item's row, when the app is unpublished or the picture deleted. */
export async function dropShowcase(kind: ShowcaseKind, ref: string): Promise<void> {
  await run("DELETE FROM showcase WHERE kind = ? AND ref = ?", [kind, ref]);
}

/** What the landing page shows: approved apps and pictures that still exist, newest approved first. */
export async function publicShowcase(): Promise<ShowcaseList> {
  const sites = await all<{ slug: string; title: string }>(
    `SELECT s.slug, s.title FROM showcase c JOIN sites s ON s.slug = c.ref AND s.user_id = c.user_id
     WHERE c.kind = 'site' AND c.status = 'shown' ORDER BY c.decided_at DESC LIMIT ?`,
    [PUBLIC_SITES],
  );
  const pictures = await all<{ id: string; name: string }>(
    `SELECT f.id, f.name FROM showcase c JOIN files f ON f.id = c.ref AND f.user_id = c.user_id
     WHERE c.kind = 'picture' AND c.status = 'shown' AND ${PICTURE} ORDER BY c.decided_at DESC LIMIT ?`,
    [PUBLIC_PICTURES],
  );
  return {
    sites: sites.map((s) => ({ slug: s.slug, title: s.title.trim() || s.slug })),
    pictures: pictures.map((p) => ({ id: p.id, title: p.name.replace(/\.[a-z0-9]+$/i, "") })),
  };
}

/** An approved picture, for anyone (the landing page shows it). Null unless it's approved and still there. */
export async function showcasePicture(id: string) {
  return one<{ mime: string; name: string; data: ArrayBuffer }>(
    `SELECT f.mime, f.name, f.data FROM showcase c JOIN files f ON f.id = c.ref AND f.user_id = c.user_id
     WHERE c.kind = 'picture' AND c.ref = ? AND c.status = 'shown' AND ${PICTURE}`,
    [id],
  );
}

export type ShowcaseItem = {
  kind: ShowcaseKind;
  ref: string;
  title: string;
  email: string;
  status: ShowcaseStatus;
  created_at: number;
  decided_at: number;
};

/** Everything offered, for the dashboard's Showcase tab: waiting first, then newest. Gone items are left out. */
export async function adminShowcase(): Promise<ShowcaseItem[]> {
  const rows = await all<ShowcaseItem>(
    `SELECT c.kind, c.ref, COALESCE(s.title, f.name) AS title, COALESCE(u.email, '') AS email, c.status, c.created_at, c.decided_at
     FROM showcase c
     LEFT JOIN sites s ON c.kind = 'site' AND s.slug = c.ref AND s.user_id = c.user_id
     LEFT JOIN files f ON c.kind = 'picture' AND f.id = c.ref AND f.user_id = c.user_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE s.slug IS NOT NULL OR f.id IS NOT NULL
     ORDER BY c.status = 'waiting' DESC, c.created_at DESC LIMIT 500`,
  );
  return rows.map((r) => ({ ...r, created_at: Number(r.created_at), decided_at: Number(r.decided_at) }));
}

/** The owner of Flash shows, hides or puts back to waiting an offered item. False when nobody offered it. */
export async function decideShowcase(kind: ShowcaseKind, ref: string, status: ShowcaseStatus): Promise<boolean> {
  const r = await run("UPDATE showcase SET status = ?, decided_at = ? WHERE kind = ? AND ref = ?", [status, status === "waiting" ? 0 : now(), kind, ref]);
  return r.rowsAffected > 0;
}
