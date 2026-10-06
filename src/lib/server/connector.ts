import { timingSafeEqual } from "node:crypto";
import { all, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { pkceChallenge } from "./oauth.ts";
import type { User } from "./auth.ts";

/**
 * "Sign in with Flash" for the Flash connector: OAuth 2.1 with PKCE, so apps like Claude or
 * ChatGPT can use Flash's tools with a user's account and credits. Apps register themselves
 * (dynamic client registration); a user approves each app once on Flash's own page.
 * Codes and tokens are stored only as hashes.
 */

const CODE_MINUTES = 10;
export const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 30;

export type Client = { id: string; name: string; redirectUris: string[]; confidential: boolean };

/**
 * Where an app may be sent back to: https addresses, http only on this computer (for desktop
 * apps and testing tools), or an app's own scheme like cursor://. Never script or data links.
 */
export function validRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 500) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") return true;
  if (scheme === "http") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && !["javascript", "data", "vbscript", "file", "blob", "about", "ws", "wss"].includes(scheme);
}

/** Registers an app. Returns its client id, and a secret when the app asked for one. */
export async function registerClient(input: {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
}): Promise<{ client: Client; secret?: string } | { error: string }> {
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return { error: "redirect_uris must list up to 10 https addresses (or http on localhost)." };
  }
  const method = input.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    return { error: "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic." };
  }
  const name =
    typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 80) : "An app";
  const id = randomId(18);
  const secret = method === "none" ? undefined : randomId(32);
  await run("INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)", [
    id,
    secret ? sha256(secret) : null,
    name,
    JSON.stringify(uris),
    now(),
  ]);
  return { client: { id, name, redirectUris: uris as string[], confidential: Boolean(secret) }, secret };
}

export async function getClient(id: string | null | undefined): Promise<Client | null> {
  if (!id) return null;
  const row = await one<{ id: string; name: string; redirect_uris: string; secret_hash: string | null }>(
    "SELECT id, name, redirect_uris, secret_hash FROM oauth_clients WHERE id = ?",
    [id],
  );
  return row && { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris), confidential: Boolean(row.secret_hash) };
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Checks an app's secret; apps registered without one need none. */
export async function clientAuthenticates(id: string, secret: string | null): Promise<boolean> {
  const row = await one<{ secret_hash: string | null }>("SELECT secret_hash FROM oauth_clients WHERE id = ?", [id]);
  if (!row) return false;
  if (!row.secret_hash) return true;
  return Boolean(secret) && sameHash(sha256(secret!), row.secret_hash);
}

/** The one-time code a user's approval sends back to the app. */
export async function createCode(c: { clientId: string; userId: string; redirectUri: string; challenge: string }): Promise<string> {
  const code = randomId(32);
  await run("DELETE FROM oauth_codes WHERE expires_at < ?", [now()]);
  await run(
    "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [sha256(code), c.clientId, c.userId, c.redirectUri, c.challenge, now() + CODE_MINUTES * 60_000],
  );
  return code;
}

/**
 * Uses a code (once). Returns the user it was approved for when the app, the return address
 * and the PKCE verifier all match, else null.
 */
export async function redeemCode(code: string, clientId: string, redirectUri: string, verifier: string): Promise<string | null> {
  if (!code || !verifier) return null;
  const row = await one<{ client_id: string; user_id: string; redirect_uri: string; challenge: string }>(
    "SELECT client_id, user_id, redirect_uri, challenge FROM oauth_codes WHERE code_hash = ? AND expires_at > ?",
    [sha256(code), now()],
  );
  if (!row) return null;
  const r = await run("DELETE FROM oauth_codes WHERE code_hash = ?", [sha256(code)]);
  if (r.rowsAffected !== 1) return null;
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) return null;
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameHash(pkceChallenge(verifier), row.challenge)) return null;
  return row.user_id;
}

export type Tokens = { access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number };

export async function issueTokens(clientId: string, userId: string): Promise<Tokens> {
  const access = randomId(32);
  const refresh = randomId(32);
  const t = now();
  await run("DELETE FROM oauth_tokens WHERE user_id = ? AND expires_at < ?", [userId, t]);
  await run(
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at, created_at) VALUES (?, 'access', ?, ?, ?, ?), (?, 'refresh', ?, ?, ?, ?)",
    [sha256(access), clientId, userId, t + ACCESS_SECONDS * 1000, t, sha256(refresh), clientId, userId, t + REFRESH_DAYS * 86_400_000, t],
  );
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_SECONDS };
}

/** Swaps a refresh token for new tokens. Each refresh token works once. */
export async function refreshTokens(refresh: string, clientId: string): Promise<Tokens | null> {
  if (!refresh) return null;
  const row = await one<{ user_id: string; client_id: string }>(
    "SELECT user_id, client_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND expires_at > ?",
    [sha256(refresh), now()],
  );
  if (!row || row.client_id !== clientId) return null;
  const r = await run("DELETE FROM oauth_tokens WHERE token_hash = ?", [sha256(refresh)]);
  if (r.rowsAffected !== 1) return null;
  return issueTokens(clientId, row.user_id);
}

/** The user and app behind an access token, or null when it is wrong or expired. */
export async function tokenUser(access: string | null | undefined): Promise<{ user: User; clientId: string } | null> {
  if (!access) return null;
  const row = await one<User & { client_id: string }>(
    `SELECT u.id, u.email, u.name, u.nickname, u.work, u.preferences, u.created_at, u.last_free_grant, u.verified_at, t.client_id
     FROM oauth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?`,
    [sha256(access), now()],
  );
  if (!row) return null;
  const { client_id, ...user } = row;
  return { user, clientId: client_id };
}

/** The apps a user has connected (with a sign-in that still works). */
export async function connectedApps(userId: string): Promise<{ id: string; name: string; since: number }[]> {
  return all<{ id: string; name: string; since: number }>(
    `SELECT c.id, c.name, MIN(t.created_at) AS since FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
     WHERE t.user_id = ? AND t.expires_at > ? GROUP BY c.id, c.name ORDER BY since DESC`,
    [userId, now()],
  );
}

/** Disconnects an app: its tokens stop working at once. */
export async function disconnectApp(userId: string, clientId: string): Promise<void> {
  await run("DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?", [userId, clientId]);
  await run("DELETE FROM oauth_codes WHERE user_id = ? AND client_id = ?", [userId, clientId]);
}

/** A link anyone can open to one of a user's files, for files a connected app made. */
export async function publicFileLink(userId: string, fileUrl: string): Promise<string | null> {
  const fileId = fileUrl.match(/^\/api\/files\/([\w-]+)$/)?.[1];
  if (!fileId) return null;
  const id = randomId(18);
  await run("INSERT INTO public_files (id, file_id, user_id, created_at) VALUES (?, ?, ?, ?)", [id, fileId, userId, now()]);
  return `/f/${id}`;
}

export async function publicFile(id: string) {
  return one<{ mime: string; name: string; data: ArrayBuffer; user_id: string }>(
    `SELECT f.mime, f.name, f.data, p.user_id FROM public_files p JOIN files f ON f.id = p.file_id AND f.user_id = p.user_id WHERE p.id = ?`,
    [id],
  );
}

export type AuthorizeRequest = { client: Client; redirectUri: string; state: string | null; challenge: string };

/** The app's address with the result of an approval added, as the app expects it. */
export function redirectWith(redirectUri: string, params: Record<string, string | null>, issuer: string): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

/**
 * Checks an app's request to connect. A bad app or return address is shown to the user (never
 * followed, so Flash can't be used to send people to a stranger's site); other problems go
 * back to the app as an OAuth error.
 */
export async function checkAuthorize(
  params: Record<string, string | undefined>,
  issuer: string,
): Promise<{ ok: AuthorizeRequest } | { fatal: string } | { redirect: string }> {
  const client = await getClient(params.client_id);
  if (!client) return { fatal: "This app isn't registered with Flash. Go back to the app and try connecting again." };
  const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!client.redirectUris.includes(redirectUri)) {
    return { fatal: "This app gave a return address it didn't register. Go back to the app and try connecting again." };
  }
  const state = params.state ?? null;
  const fail = (error: string, description: string) => ({
    redirect: redirectWith(redirectUri, { error, error_description: description, state }, issuer),
  });
  if (params.response_type !== "code") return fail("unsupported_response_type", "Flash supports response_type=code.");
  if (!params.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge) || params.code_challenge_method !== "S256") {
    return fail("invalid_request", "Flash needs PKCE with code_challenge_method=S256.");
  }
  return { ok: { client, redirectUri, state, challenge: params.code_challenge } };
}
