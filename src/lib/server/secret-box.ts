import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * Where connector secrets are kept: every API key, token and password a user gives Flash for one of
 * their accounts is stored only through seal() and read only through unseal(). AES-256-GCM, a random
 * 12-byte IV per secret, and associated data naming the row, user, service and field, so a stored
 * secret copied to another row, user or field doesn't open. Stored as "<version>:<iv>:<tag>:<ct>" in
 * base64url, the version naming the key in CONNECTOR_KEYS that sealed it.
 *
 * CONNECTOR_KEYS is a JSON object of key versions, each 32 random bytes in base64:
 * {"v1":"..."}. New secrets are sealed with the highest version and older ones still open, so a key
 * is rotated by adding "v2" (and later dropping "v1" once nothing uses it). Until it is set, Flash
 * has no connectors: nothing is stored, and users aren't shown them (see connectorsReady).
 *
 * Neither the keys nor the secrets are ever logged, returned by an API or written anywhere else.
 * Errors here say only what went wrong, never with the value.
 */

type Keys = { newest: string; byVersion: Map<string, Buffer> };

// The entries of CONNECTOR_KEYS that can't be used, each by its name and why (never its value).
type Skipped = { version: string; reason: string }[];

let cache: { raw: string; keys: Keys | null; skipped: Skipped } | null = null;

const versionNumber = (v: string) => Number(/^v(\d{1,6})$/.exec(v)?.[1] ?? NaN);

/** The keys in CONNECTOR_KEYS, or null when it is missing or not usable. */
function keys(): Keys | null {
  const raw = process.env.CONNECTOR_KEYS ?? "";
  if (cache?.raw === raw) return cache.keys;
  let parsed: Keys | null = null;
  const skipped: Skipped = [];
  try {
    const value: unknown = raw.trim() ? JSON.parse(raw) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const byVersion = new Map<string, Buffer>();
      for (const [version, encoded] of Object.entries(value)) {
        // A name that isn't a version is shown only when it's short and plain: it could be a pasted key.
        const name = /^[\w-]{1,12}$/.test(version) ? version : "an entry";
        if (!Number.isFinite(versionNumber(version))) skipped.push({ version: name, reason: "its name isn't v1, v2, … in lower case" });
        else if (typeof encoded !== "string" || Buffer.from(encoded, "base64").length !== 32) skipped.push({ version: name, reason: "it isn't 32 bytes in base64" });
        else byVersion.set(version, Buffer.from(encoded, "base64"));
      }
      const newest = [...byVersion.keys()].sort((a, b) => versionNumber(b) - versionNumber(a))[0];
      if (newest) parsed = { newest, byVersion };
    }
  } catch {
    parsed = null;
  }
  if (raw.trim() && !parsed) console.error("[flash] CONNECTOR_KEYS is set but holds no usable key (a JSON object like {\"v1\":\"<32 bytes in base64>\"})");
  // Once for each value of CONNECTOR_KEYS: a rotation with a mistyped entry would otherwise go on sealing with the old key.
  for (const s of skipped) console.error(`[flash] CONNECTOR_KEYS: ${s.version} can't be used: ${s.reason}`);
  cache = { raw, keys: parsed, skipped };
  return parsed;
}

/** Which key seals new secrets, and the entries of CONNECTOR_KEYS that can't be used (by name, never value), for /admin. */
export function keyVersions(): { newest: string; skipped: Skipped } {
  const k = keys();
  return { newest: k?.newest ?? "", skipped: cache?.skipped ?? [] };
}

/** Whether connectors can store secrets: CONNECTOR_KEYS holds at least one usable key. */
export const connectorsReady = () => keys() !== null;

/** What a secret is bound to: its row, its user, its service and which of the row's secrets it is. */
export type SecretPlace = { id: string; userId: string; provider: string; field: string };

const associated = (p: SecretPlace) => Buffer.from(`connections:${p.id}:${p.userId}:${p.provider}:${p.field}`, "utf8");

/** Seals a secret for storing in its place, with the newest key. */
export function seal(secret: string, place: SecretPlace): { stored: string; version: string } {
  const k = keys();
  if (!k) throw new Error("Connector keys aren't set up.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k.byVersion.get(k.newest)!, iv);
  cipher.setAAD(associated(place));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { stored: [k.newest, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":"), version: k.newest };
}

/** Opens a sealed secret, only in the place it was sealed for. Throws a message without the value on any mismatch. */
export function unseal(stored: string, place: SecretPlace): string {
  const k = keys();
  if (!k) throw new Error("Connector keys aren't set up.");
  const [version, iv, tag, ct, ...rest] = stored.split(":");
  const key = k.byVersion.get(version);
  if (!key || !iv || !tag || ct === undefined || rest.length) throw new Error("A stored connector secret can't be opened.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 });
    decipher.setAAD(associated(place));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("A stored connector secret can't be opened.");
  }
}

/** The last 4 characters of a secret, the only part of it Flash ever shows. */
export const lastFour = (secret: string) => (secret.length >= 12 ? secret.slice(-4) : "");
