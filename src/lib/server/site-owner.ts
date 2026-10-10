/*
 * Owner mode: the owner of a published app can change its shared data from the app itself, for
 * example the dishes on a menu. It starts only when the owner asks for it in Flash (Open as owner
 * in My websites & apps): Flash's own page makes a one-time code, the browser opens the app with
 * it, and the page Flash serves for it trades the code for an owner key that the app's data
 * requests carry. Opening the app any other way, even signed in to Flash, shows it as visitors see
 * it, so a link someone sends the owner can't start owner mode. It works on the app's own domain
 * too, where Flash's sign-in cookie never goes.
 *
 * An owner key works for that app's shared data only, and not for its private collections (only
 * Flash's Data view shows those): not for its settings, its AI, money, each person's own records or
 * any other app. The page uses it until it is reloaded or closed; it works for an hour at most, and
 * ends sooner when the owner signs out of Flash or the app is unpublished. Like the visitors' page
 * keys, only hashes are kept.
 */
import { db, one, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { visitorForPageToken } from "./site-auth.ts";
import { ANYONE, OWNER_IN_APP, type Caller } from "../data-rules.ts";

const MINUTE = 60_000;
// A code only has to last from the click in Flash until the app opens.
const OWNER_CODE_MS = 2 * MINUTE;
const OWNER_KEY_MS = 60 * MINUTE;
// Live keys kept per app and owner, so a busy owner doesn't fill the table.
const MAX_LIVE_KEYS = 20;
export const OWNER_KEY_PREFIX = "o_";

/**
 * A one-time code that opens the app as its owner, made when they choose Open as owner in Flash, or
 * null when the user doesn't own the app. It ends with their Flash sign-in, like the key it becomes.
 */
export async function newOwnerCode(slug: string, userId: string, flashSessionToken: string): Promise<string | null> {
  if (!flashSessionToken) return null;
  const code = randomId(24);
  const at = now();
  const [, made] = await (
    await db()
  ).batch(
    [
      { sql: "DELETE FROM site_owner_codes WHERE expires_at <= ?", args: [at] },
      {
        // Made only when the app is this user's.
        sql: `INSERT INTO site_owner_codes (code_hash, site_slug, user_id, session_hash, expires_at)
              SELECT ?, slug, user_id, ?, ? FROM sites WHERE slug = ? AND user_id = ?`,
        args: [sha256(code), sha256(flashSessionToken), at + OWNER_CODE_MS, slug, userId],
      },
    ],
    "write",
  );
  return made.rowsAffected ? code : null;
}

/**
 * Trades a one-time code for an owner key for this app, with the owner's language for what the page
 * tells them, or null when the code is unknown, used, too old, for another app, or its owner has
 * signed out of Flash or no longer owns the app. A code works once, even when two pages race for it:
 * it's used up in the same transaction that makes the key.
 */
export async function ownerKeyForCode(slug: string, code: string): Promise<{ key: string; language: string } | null> {
  if (!code || code.length > 100) return null;
  const key = OWNER_KEY_PREFIX + randomId(24);
  const codeHash = sha256(code);
  const keyHash = sha256(key);
  const at = now();
  const results = await (
    await db()
  ).batch(
    [
      {
        sql: `INSERT INTO site_owner_keys (token_hash, site_slug, user_id, session_hash, expires_at)
              SELECT ?, c.site_slug, c.user_id, c.session_hash, ? FROM site_owner_codes c
              JOIN sites s ON s.slug = c.site_slug AND s.user_id = c.user_id
              JOIN sessions se ON se.token_hash = c.session_hash AND se.user_id = c.user_id AND se.expires_at > ?
              WHERE c.code_hash = ? AND c.site_slug = ? AND c.expires_at > ?`,
        args: [keyHash, at + OWNER_KEY_MS, at, codeHash, slug, at],
      },
      { sql: "DELETE FROM site_owner_codes WHERE code_hash = ? OR expires_at <= ?", args: [codeHash, at] },
      { sql: "DELETE FROM site_owner_keys WHERE expires_at <= ?", args: [at] },
      {
        // The owner's newest keys for this app stay; the new one is the newest.
        sql: `DELETE FROM site_owner_keys WHERE site_slug = ? AND user_id = (SELECT user_id FROM site_owner_keys WHERE token_hash = ?)
              AND token_hash NOT IN (SELECT token_hash FROM site_owner_keys WHERE site_slug = ? AND user_id =
                (SELECT user_id FROM site_owner_keys WHERE token_hash = ?) ORDER BY expires_at DESC LIMIT ?)`,
        args: [slug, keyHash, slug, keyHash, MAX_LIVE_KEYS],
      },
      { sql: "SELECT u.language FROM site_owner_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?", args: [keyHash] },
    ],
    "write",
  );
  if (!results[0].rowsAffected) return null;
  return { key, language: String(results.at(-1)!.rows[0]?.language ?? "") };
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
 * Who is asking, from the Authorization header of a request to an app's shared data: its owner in
 * the app itself, someone signed in to the app, or anyone. A key that doesn't work counts as no
 * key, so reading still works after a page key ends.
 */
export async function callerFor(slug: string, authorization: string | null): Promise<Caller> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return ANYONE;
  if (token.startsWith(OWNER_KEY_PREFIX) && (await isOwnerKey(slug, token))) return OWNER_IN_APP;
  // A visitor's page key can start with "o_" by chance, so it's looked up whatever it starts with.
  const who = await visitorForPageToken(slug, authorization);
  return who ? { kind: "visitor", id: who.id } : ANYONE;
}

/** Whether a request carried an owner key that no longer works, so the owner's page can say why it was refused. */
export const ownerKeyEnded = (authorization: string | null, caller: Caller) =>
  caller.kind === "anyone" && /^Bearer\s+o_/i.test(authorization ?? "");
