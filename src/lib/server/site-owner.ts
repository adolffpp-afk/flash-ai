/*
 * Owner mode: the owner of a published app can change its shared data from the app itself, for
 * example the dishes on a menu. When the owner opens their app on Flash while signed in to Flash,
 * the page gets an owner key, and the app's data requests carry it.
 *
 * An owner key works for that app's shared data only: not for its settings, its AI, money, each
 * person's own records or any other app. It ends after two hours, when the owner signs out of
 * Flash, or when the app is unpublished. Like the visitors' page keys, only its hash is kept.
 */
import { db, one, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { visitorForPageToken } from "./site-auth.ts";
import { ANYONE, OWNER, type Caller } from "../data-rules.ts";

const OWNER_KEY_MINUTES = 120;
// Live keys kept per app and owner: one per page load, so a busy owner doesn't fill the table.
const MAX_LIVE_KEYS = 20;
const MINUTE = 60_000;
export const OWNER_KEY_PREFIX = "o_";

/**
 * A new owner key for one page load, made from the owner's Flash sign-in, or null when the user
 * doesn't own the app. One round trip: it also clears expired keys and keeps the newest 20.
 */
export async function newOwnerKey(slug: string, userId: string, flashSessionToken: string): Promise<string | null> {
  if (!flashSessionToken) return null;
  const key = OWNER_KEY_PREFIX + randomId(24);
  const at = now();
  const [, made] = await (
    await db()
  ).batch(
    [
      { sql: "DELETE FROM site_owner_keys WHERE expires_at <= ?", args: [at] },
      {
        // Made only when the app is this user's.
        sql: `INSERT INTO site_owner_keys (token_hash, site_slug, user_id, session_hash, expires_at)
              SELECT ?, slug, user_id, ?, ? FROM sites WHERE slug = ? AND user_id = ?`,
        args: [sha256(key), sha256(flashSessionToken), at + OWNER_KEY_MINUTES * MINUTE, slug, userId],
      },
      {
        sql: `DELETE FROM site_owner_keys WHERE site_slug = ? AND user_id = ? AND token_hash NOT IN
                (SELECT token_hash FROM site_owner_keys WHERE site_slug = ? AND user_id = ? ORDER BY expires_at DESC LIMIT ?)`,
        args: [slug, userId, slug, userId, MAX_LIVE_KEYS],
      },
    ],
    "write",
  );
  return made.rowsAffected ? key : null;
}

/** Whether a key is a live owner key for this app: the app is still the same user's, and their Flash sign-in still lasts. */
export async function isOwnerKey(slug: string, key: string): Promise<boolean> {
  const at = now();
  return Boolean(
    await one(
      `SELECT 1 FROM site_owner_keys k
       JOIN sites s ON s.slug = k.site_slug AND s.user_id = k.user_id
       JOIN sessions se ON se.token_hash = k.session_hash AND se.user_id = k.user_id AND se.expires_at > ?
       WHERE k.token_hash = ? AND k.site_slug = ? AND k.expires_at > ?`,
      [at, sha256(key), slug, at],
    ),
  );
}

/**
 * Who is asking, from the Authorization header of a request to an app's shared data: its owner,
 * someone signed in to the app, or anyone. A key that doesn't work counts as no key, so reading
 * still works after a page key ends.
 */
export async function callerFor(slug: string, authorization: string | null): Promise<Caller> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return ANYONE;
  if (token.startsWith(OWNER_KEY_PREFIX) && (await isOwnerKey(slug, token))) return OWNER;
  // A visitor's page key can start with "o_" by chance, so it's looked up whatever it starts with.
  const who = await visitorForPageToken(slug, authorization);
  return who ? { kind: "visitor", id: who.id } : ANYONE;
}
