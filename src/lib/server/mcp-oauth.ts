import { db, now, one, run } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { pkceChallenge } from "./oauth.ts";
import { checkUrl, mockOrigin, safeFetch, SafeFetchError, type SafeRequest, type SafeResponse } from "./safe-fetch.ts";
import { keyVersions, seal, unseal, type SecretPlace } from "./secret-box.ts";
import { isOwnHost } from "../site-host.ts";

/*
 * Signing in to an MCP server with OAuth 2.1 (one-click Connect, see the connectors plan, PR 2), as
 * the MCP authorization spec (2025-11-25 and 2026-07-28) asks of a client:
 * - the protected resource's metadata, from the server's WWW-Authenticate or its well-known
 *   addresses, naming a resource that is the server's own (another server's is refused);
 * - the authorization server's metadata, tried at the three addresses in the spec's order, refusing
 *   a server without PKCE S256 and any endpoint that isn't https (the sign-in page also never on one
 *   of Flash's own hosts, where the browser would carry Flash's session);
 * - who Flash is there: its Client ID Metadata Document first, then Dynamic Client Registration
 *   (application_type "web"), else a client ID and secret the user made there themselves, which are
 *   theirs alone. Flash's own registrations are kept by issuer and shared, so re-registering never
 *   orphans earlier sign-ins;
 * - `resource` on the authorization and token requests, `iss` checked on the way back, and the union
 *   of the scopes asked for so far when a server asks for more (step-up).
 *
 * A sign-in under way is a row in connect_flows, never a cookie: the callback acts on it, so it must
 * be something the browser can't edit. It is taken once, by its own user, with one conditional DELETE.
 *
 * Every request here goes through safeFetch (no private or local addresses, no Flash hosts, size and
 * time caps). Tokens, secrets and codes are never logged, put in a URL Flash shows, or returned by an
 * API; an authorization server's own error text is never shown or logged either.
 */

/** Why a sign-in couldn't start or finish. Shown to users only as a fixed message (see connections.ts). */
export type OAuthProblem =
  // No usable protected-resource or authorization-server metadata.
  | "no_signin"
  // The metadata names a resource that isn't this server.
  | "resource"
  // The authorization server doesn't do PKCE with S256.
  | "no_s256"
  // An endpoint that isn't https, or that is on one of Flash's own hosts.
  | "endpoint"
  // Neither a Client ID Metadata Document nor Dynamic Client Registration: the user must type a client ID.
  | "needs_client"
  // Dynamic Client Registration failed.
  | "registration"
  // The callback's iss isn't the authorization server's.
  | "iss"
  // A server the user added whose authorization server doesn't say it sends iss: see requireIss.
  | "no_iss"
  // The token endpoint refused, or answered with something that isn't a token.
  | "token"
  // The grant is gone (invalid_grant, or the client was refused): the user must sign in again.
  | "invalid_grant"
  // A network problem on the way.
  | "unreachable";

export class OAuthError extends Error {
  code: OAuthProblem;
  constructor(code: OAuthProblem, message = "The sign-in couldn't be done.") {
    super(message);
    this.code = code;
  }
}

/** How long a sign-in may take, from Connect to the callback. */
export const FLOW_TTL_MS = 10 * 60_000;
// Each metadata, registration, token or revocation request.
const REQUEST_MS = 10_000;
const METADATA_MAX = 256 * 1024;
const TOKEN_MAX = 64 * 1024;

/** The address of Flash's Client ID Metadata Document, which is also its client_id there. */
export const cimdUrl = (origin: string) => `${origin}/oauth/mcp-client.json`;
/** Where authorization servers send the browser back. */
export const callbackUrl = (origin: string) => `${origin}/api/connect/mcp/callback`;

/** Flash's Client ID Metadata Document, served at cimdUrl (src/app/oauth/mcp-client.json/route.ts). */
export function clientMetadata(origin: string) {
  return {
    client_id: cimdUrl(origin),
    client_name: "Flash AI",
    client_uri: origin,
    redirect_uris: [callbackUrl(origin)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
}

// ---------------------------------------------------------------------------------------------
// What a server says about signing in

/** The parts of a Bearer WWW-Authenticate challenge Flash reads. */
export type Challenge = { resourceMetadata: string; scope: string; error: string };

/**
 * Reads a WWW-Authenticate header's Bearer challenge: resource_metadata, scope and error. Other
 * schemes and parameters are skipped; a header without a Bearer challenge gives empty values.
 */
export function parseChallenge(header: string | undefined | null): Challenge {
  const out: Challenge = { resourceMetadata: "", scope: "", error: "" };
  const text = String(header ?? "").slice(0, 4000);
  const start = /(^|[\s,])bearer(\s+|$)/i.exec(text);
  if (!start) return out;
  // auth-param = token BWS "=" BWS ( token / quoted-string ), separated by commas.
  const param = /\s*,?\s*([A-Za-z0-9_.-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^\s,"]*)/y;
  param.lastIndex = start.index + start[0].length;
  for (let m = param.exec(text); m; m = param.exec(text)) {
    const value = m[3] !== undefined ? m[3].replace(/\\(.)/g, "$1") : m[2];
    const key = m[1].toLowerCase();
    if (key === "resource_metadata") out.resourceMetadata = value;
    else if (key === "scope") out.scope = value;
    else if (key === "error") out.error = value;
  }
  return out;
}

/** The scopes in a space-separated list, each a valid scope-token (RFC 6749 §3.3), at most 50. */
export function scopeList(value: string | string[] | undefined | null): string[] {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/\s+/);
  return [...new Set(items.filter((s): s is string => typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s)))].slice(0, 50);
}

/** The union of scope lists, in order: what was asked before first, then what a server asks for now (step-up). */
export const unionScopes = (...lists: (string | string[] | undefined | null)[]) => scopeList(lists.flatMap((l) => scopeList(l)));

/**
 * Whether protected-resource metadata's `resource` is this server: the same origin, with a path that
 * is the server's own or a parent of it (a server at /mcp may say its resource is the origin). Any
 * other resource is another server's, and is refused.
 */
export function resourceMatches(serverUrl: string, resource: unknown): boolean {
  if (typeof resource !== "string" || !resource) return false;
  let s: URL;
  let r: URL;
  try {
    s = new URL(serverUrl);
    r = new URL(resource);
  } catch {
    return false;
  }
  if (r.hash || r.username || r.password || r.origin !== s.origin) return false;
  const sp = s.pathname.replace(/\/+$/, "");
  const rp = r.pathname.replace(/\/+$/, "");
  return rp === "" || sp === rp || sp.startsWith(`${rp}/`);
}

/** A JSON object from a metadata address, or null when it has none there (not 200, or not JSON). */
async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  let res: SafeResponse;
  try {
    res = await safeFetch(url, { headers: { accept: "application/json" }, accept: ["json"], maxBytes: METADATA_MAX, timeoutMs: REQUEST_MS, signal });
  } catch (err) {
    // A page that isn't JSON (an app's own page for any address) has no metadata: the next address is tried.
    if (err instanceof SafeFetchError && err.code === "bad_type" && !signal?.aborted) return null;
    throw fetchProblem(err, signal);
  }
  if (res.status !== 200) return null;
  try {
    const value: unknown = JSON.parse(res.body);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A failed request as an OAuthError: a blocked address is an endpoint Flash won't use; Stop goes on as it is. */
function fetchProblem(err: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return err;
  if (err instanceof OAuthError) return err;
  if (err instanceof SafeFetchError) {
    if (err.code === "blocked") return new OAuthError("endpoint");
    if (err.code === "bad_type") return new OAuthError("no_signin");
  }
  return new OAuthError("unreachable", "The server couldn't be reached.");
}

const httpsUrl = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new OAuthError("endpoint");
  try {
    const url = checkUrl(value);
    if (url.hash) throw new OAuthError("endpoint");
    return url.href;
  } catch {
    throw new OAuthError("endpoint");
  }
};

/** What a server's protected-resource metadata says: the resource to ask for, its authorization servers and scopes. */
export type ResourceMeta = { resource: string; authorizationServers: string[]; scopes: string[] };

/**
 * The protected-resource metadata of a server: from the address its WWW-Authenticate named, else
 * /.well-known/oauth-protected-resource with the server's path, else at the root. The first one
 * found is used, and its resource must be this server.
 */
export async function findResource(serverUrl: string, challenge: Challenge, signal?: AbortSignal): Promise<ResourceMeta> {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const tried = [
    ...(challenge.resourceMetadata ? [challenge.resourceMetadata] : []),
    ...(path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const address of tried) {
    const doc = await getJson(address, signal);
    if (!doc) continue;
    const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers.filter((s): s is string => typeof s === "string") : [];
    if (!servers.length) continue;
    if (!resourceMatches(serverUrl, doc.resource)) throw new OAuthError("resource");
    return { resource: doc.resource as string, authorizationServers: servers.slice(0, 5), scopes: scopeList(doc.scopes_supported as string[]) };
  }
  throw new OAuthError("no_signin");
}

/** An authorization server, as its metadata says, with every endpoint checked. */
export type AuthServer = {
  // Exactly as the metadata says: the iss a callback must carry.
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  // It says it adds iss to its answers (RFC 9207): one without it is refused.
  issParameter: boolean;
  // It takes a Client ID Metadata Document as client_id.
  cimd: boolean;
  scopes: string[];
  authMethods: string[];
};

/**
 * Where an issuer's metadata may be, in the order the MCP spec gives: OAuth metadata then OpenID
 * configuration with the issuer's path after the well-known part, then OpenID configuration after
 * the issuer's path. An issuer without a path has the first two only.
 */
export function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * The sign-in page's address, only when it is https (or the dev mock's), has no user name in it,
 * and isn't one of Flash's own hosts: the browser goes there with Flash's Lax session cookie, so a
 * server could otherwise send it to a Flash address that changes something.
 */
export function checkAuthorizeUrl(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new OAuthError("endpoint");
  }
  const mock = mockOrigin();
  if (mock && url.origin === mock) return url;
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new OAuthError("endpoint");
  if (isOwnHost(url.hostname.toLowerCase().replace(/\.$/, ""))) throw new OAuthError("endpoint");
  try {
    checkUrl(url);
  } catch {
    throw new OAuthError("endpoint");
  }
  return url;
}

/** An authorization server's metadata, checked: the issuer it says it is, PKCE S256, https endpoints. */
export async function findAuthServer(issuer: string, signal?: AbortSignal): Promise<AuthServer> {
  const checked = httpsUrl(issuer);
  if (new URL(checked).search) throw new OAuthError("endpoint");
  for (const address of metadataUrls(checked)) {
    const doc = await getJson(address, signal);
    if (!doc) continue;
    // RFC 8414 §3.3: metadata naming another issuer must not be used.
    if (typeof doc.issuer !== "string" || !sameIssuer(doc.issuer, issuer)) throw new OAuthError("no_signin");
    const methods = Array.isArray(doc.code_challenge_methods_supported) ? doc.code_challenge_methods_supported : [];
    if (!methods.includes("S256")) throw new OAuthError("no_s256");
    const types = doc.response_types_supported;
    if (Array.isArray(types) && !types.includes("code")) throw new OAuthError("no_signin");
    const grants = doc.grant_types_supported;
    if (Array.isArray(grants) && !grants.includes("authorization_code")) throw new OAuthError("no_signin");
    const optional = (value: unknown) => (value === undefined || value === null || value === "" ? "" : httpsUrl(value));
    return {
      issuer: doc.issuer,
      authorizationEndpoint: checkAuthorizeUrl(doc.authorization_endpoint).href,
      tokenEndpoint: httpsUrl(doc.token_endpoint),
      registrationEndpoint: optional(doc.registration_endpoint),
      revocationEndpoint: optional(doc.revocation_endpoint),
      issParameter: doc.authorization_response_iss_parameter_supported === true,
      cimd: doc.client_id_metadata_document_supported === true,
      scopes: scopeList(doc.scopes_supported as string[]),
      authMethods: Array.isArray(doc.token_endpoint_auth_methods_supported)
        ? doc.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === "string")
        : ["client_secret_basic"],
    };
  }
  throw new OAuthError("no_signin");
}

/**
 * Asks the server for nothing, without a token, to read its WWW-Authenticate (a server that wants a
 * sign-in answers 401). An empty string when it says nothing.
 */
export async function probeChallenge(serverUrl: string, signal?: AbortSignal): Promise<string> {
  let res: SafeResponse;
  try {
    res = await safeFetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "FlashAI/1.0 (+https://www.flash-app.dev)" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Flash AI", version: "1.0.0" } } }),
      maxBytes: 64 * 1024,
      timeoutMs: REQUEST_MS,
      signal,
    });
  } catch (err) {
    if (err instanceof SafeFetchError && err.code === "bad_type") return "";
    throw fetchProblem(err, signal);
  }
  return res.status === 401 || res.status === 403 ? String(res.headers["www-authenticate"] ?? "").slice(0, 2000) : "";
}

/** What signing in to a server would be: its resource, its authorization server, and the scopes to ask for. */
export type SignInPlan = { resource: ResourceMeta; server: AuthServer; scopes: string[] };

/**
 * Finds how to sign in to a server (its challenge, read first when not given): its resource and
 * authorization server, checked, and the scopes to ask for: those its challenge names, else those
 * its resource lists, plus any asked for before (`more`), plus offline_access when the
 * authorization server offers it (for a refresh token).
 */
export async function planSignIn(serverUrl: string, { challenge, more = [], signal }: { challenge?: string; more?: string[]; signal?: AbortSignal } = {}): Promise<SignInPlan> {
  const header = challenge ?? (await probeChallenge(serverUrl, signal));
  const parsed = parseChallenge(header);
  const resource = await findResource(serverUrl, parsed, signal);
  const server = await findAuthServer(resource.authorizationServers[0], signal);
  const asked = scopeList(parsed.scope);
  const scopes = unionScopes(asked.length ? asked : resource.scopes, more, server.scopes.includes("offline_access") ? ["offline_access"] : []);
  return { resource, server, scopes };
}

// ---------------------------------------------------------------------------------------------
// Who Flash is to an authorization server

type RegistrationRow = {
  id: string;
  issuer: string;
  owner_user_id: string | null;
  redirect_uri: string;
  client_id: string;
  enc_client_secret: string;
  enc_registration_token: string;
  auth_method: string;
  method: "cimd" | "dcr" | "pre";
  key_version: string;
  created_at: number;
};

/** Flash's client at one authorization server, with its secret opened (or "" for a public client). */
export type OAuthClient = { regId: string; clientId: string; secret: string; authMethod: string; method: RegistrationRow["method"] };

const regPlace = (row: Pick<RegistrationRow, "id" | "owner_user_id">, field: "client_secret"): SecretPlace => ({
  id: row.id,
  userId: row.owner_user_id ?? "",
  provider: "mcp-client",
  field,
});

/**
 * A registration as Flash uses it, with its secret opened. A secret sealed with an older key version
 * is sealed again with the newest one (only if it is still the one read, so a client ID typed in at
 * the same moment stays), so a rotation of CONNECTOR_KEYS reaches registrations as they are used. A
 * row without a secret holds nothing sealed and records no version (rows from before kept a
 * registration token Flash never used: it is dropped).
 */
async function opened(row: RegistrationRow): Promise<OAuthClient> {
  const secret = row.enc_client_secret ? unseal(row.enc_client_secret, regPlace(row, "client_secret")) : "";
  const newest = keyVersions().newest;
  if (secret && newest && row.key_version !== newest) {
    const sealed = seal(secret, regPlace(row, "client_secret"));
    await run("UPDATE mcp_client_registrations SET enc_client_secret = ?, enc_registration_token = '', key_version = ? WHERE id = ? AND enc_client_secret = ?", [
      sealed.stored,
      sealed.version,
      row.id,
      row.enc_client_secret,
    ]);
  } else if (!secret && (row.key_version || row.enc_registration_token)) {
    await run("UPDATE mcp_client_registrations SET enc_registration_token = '', key_version = '' WHERE id = ? AND enc_client_secret = ''", [row.id]);
  }
  return { regId: row.id, clientId: row.client_id, secret, authMethod: row.auth_method, method: row.method };
}

/**
 * A registration a user may use: Flash's shared ones, or their own. A client ID and secret another
 * user typed in is never found here for anyone else.
 */
export async function usableClient(userId: string, regId: string): Promise<OAuthClient | null> {
  const row = await one<RegistrationRow>("SELECT * FROM mcp_client_registrations WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)", [regId, userId]);
  return row ? opened(row) : null;
}

/** The registration a user has made themselves at an issuer, if any. */
async function ownClientRow(userId: string, issuer: string) {
  return one<RegistrationRow>("SELECT * FROM mcp_client_registrations WHERE issuer = ? AND owner_user_id = ?", [issuer, userId]);
}

const sharedRow = (issuer: string, redirectUri: string) =>
  one<RegistrationRow>("SELECT * FROM mcp_client_registrations WHERE issuer = ? AND redirect_uri = ? AND owner_user_id IS NULL", [issuer, redirectUri]);

/** A client ID and secret a user typed in, as they may be used: printable, and not too long. */
export function typedClient(clientId: unknown, clientSecret: unknown): { clientId: string; clientSecret: string } | null {
  const id = typeof clientId === "string" ? clientId.trim() : "";
  const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
  if (!id) return null;
  if (!/^[\x21-\x7e]{1,512}$/.test(id) || !/^[\x21-\x7e]{0,2048}$/.test(secret)) throw new OAuthError("needs_client");
  return { clientId: id, clientSecret: secret };
}

/** Whether a user can sign in to this authorization server without typing a client ID. */
export async function canRegister(userId: string, server: AuthServer, redirectUri: string): Promise<boolean> {
  return server.cimd || Boolean(server.registrationEndpoint) || Boolean(await sharedRow(server.issuer, redirectUri)) || Boolean(await ownClientRow(userId, server.issuer));
}

/**
 * Who Flash is to this authorization server for this user:
 * 1. the client ID and secret they typed in, kept for them alone (replacing any they typed before);
 * 2. for a Reconnect, the registration the connection used, when it is still theirs to use;
 * 3. Flash's own registration there, made once and shared;
 * 4. else Flash's Client ID Metadata Document, when the server takes one;
 * 5. else a new registration by DCR, kept by issuer;
 * 6. else the client ID they typed in for this server before.
 * With none of these, the user must make a client there (needs_client).
 */
export async function clientAt(
  userId: string,
  server: AuthServer,
  { origin, redirectUri, typed, reuse, signal }: { origin: string; redirectUri: string; typed?: { clientId: string; clientSecret: string } | null; reuse?: string; signal?: AbortSignal },
): Promise<OAuthClient> {
  if (typed) return keepTyped(userId, server, typed);
  if (reuse) {
    const row = await one<RegistrationRow>("SELECT * FROM mcp_client_registrations WHERE id = ? AND issuer = ? AND (owner_user_id IS NULL OR owner_user_id = ?)", [reuse, server.issuer, userId]);
    if (row && (row.owner_user_id || row.redirect_uri === redirectUri)) return opened(row);
  }
  const shared = await sharedRow(server.issuer, redirectUri);
  if (shared) return opened(shared);
  if (server.cimd) return keepShared(server.issuer, redirectUri, { client_id: cimdUrl(origin), method: "cimd", auth_method: "none" });
  if (server.registrationEndpoint) return register(server, origin, redirectUri, signal);
  const own = await ownClientRow(userId, server.issuer);
  if (own) return opened(own);
  throw new OAuthError("needs_client");
}

/** Keeps a shared registration, or takes the one another request kept first (one per issuer and callback). */
async function keepShared(
  issuer: string,
  redirectUri: string,
  r: { client_id: string; method: RegistrationRow["method"]; auth_method: string; secret?: string },
): Promise<OAuthClient> {
  const id = randomId(12);
  const place = { id, owner_user_id: null };
  const secret = r.secret ? seal(r.secret, regPlace(place, "client_secret")) : null;
  await run(
    `INSERT OR IGNORE INTO mcp_client_registrations (id, issuer, owner_user_id, redirect_uri, client_id, enc_client_secret, auth_method, method, key_version, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [id, issuer, redirectUri, r.client_id, secret?.stored ?? "", r.auth_method, r.method, secret?.version ?? "", now()],
  );
  const row = await sharedRow(issuer, redirectUri);
  if (!row) throw new OAuthError("registration");
  return opened(row);
}

/** The client ID and secret a user typed in, kept for them alone at this issuer. */
async function keepTyped(userId: string, server: AuthServer, typed: { clientId: string; clientSecret: string }): Promise<OAuthClient> {
  const methods = server.authMethods;
  const authMethod = !typed.clientSecret
    ? "none"
    : methods.includes("client_secret_basic") || !methods.includes("client_secret_post")
      ? "client_secret_basic"
      : "client_secret_post";
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await ownClientRow(userId, server.issuer);
    const id = existing?.id ?? randomId(12);
    const secret = typed.clientSecret ? seal(typed.clientSecret, regPlace({ id, owner_user_id: userId }, "client_secret")) : null;
    if (existing) {
      await run("UPDATE mcp_client_registrations SET client_id = ?, enc_client_secret = ?, enc_registration_token = '', auth_method = ?, method = 'pre', key_version = ? WHERE id = ? AND owner_user_id = ?", [
        typed.clientId,
        secret?.stored ?? "",
        authMethod,
        secret?.version ?? "",
        id,
        userId,
      ]);
    } else {
      const added = await run(
        `INSERT OR IGNORE INTO mcp_client_registrations (id, issuer, owner_user_id, redirect_uri, client_id, enc_client_secret, auth_method, method, key_version, created_at)
         VALUES (?, ?, ?, '', ?, ?, ?, 'pre', ?, ?)`,
        [id, server.issuer, userId, typed.clientId, secret?.stored ?? "", authMethod, secret?.version ?? "", now()],
      );
      // Another request kept one first: write over it on the next round.
      if (!added.rowsAffected) continue;
    }
    return { regId: id, clientId: typed.clientId, secret: typed.clientSecret, authMethod, method: "pre" };
  }
  throw new OAuthError("registration");
}

/** Registers Flash with Dynamic Client Registration (RFC 7591) as a web app, and keeps it by issuer. */
async function register(server: AuthServer, origin: string, redirectUri: string, signal?: AbortSignal): Promise<OAuthClient> {
  let res: SafeResponse;
  try {
    res = await safeFetch(server.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Flash AI",
        client_uri: origin,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      }),
      accept: ["json"],
      maxBytes: TOKEN_MAX,
      timeoutMs: REQUEST_MS,
      followRedirects: false,
      signal,
    });
  } catch (err) {
    throw fetchProblem(err, signal);
  }
  if (res.status !== 200 && res.status !== 201) throw new OAuthError("registration");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new OAuthError("registration");
  }
  const clientId = typeof body.client_id === "string" && /^[\x21-\x7e]{1,512}$/.test(body.client_id) ? body.client_id : "";
  if (!clientId) throw new OAuthError("registration");
  const secret = typeof body.client_secret === "string" && /^[\x21-\x7e]{1,2048}$/.test(body.client_secret) ? body.client_secret : "";
  // A registration_access_token (RFC 7592) isn't kept: Flash never updates or deletes its registration.
  const said = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "";
  const authMethod = !secret ? "none" : said === "client_secret_post" ? "client_secret_post" : "client_secret_basic";
  return keepShared(server.issuer, redirectUri, { client_id: clientId, method: "dcr", auth_method: authMethod, secret });
}

// ---------------------------------------------------------------------------------------------
// The sign-in itself

/** The endpoints a flow and a connection keep: where tokens are got and given back, and whether iss comes back. */
export type Endpoints = { token: string; revocation: string; iss: boolean };

export const readEndpoints = (json: string): Endpoints => {
  try {
    const e = JSON.parse(json) as Partial<Endpoints>;
    return { token: typeof e.token === "string" ? e.token : "", revocation: typeof e.revocation === "string" ? e.revocation : "", iss: e.iss === true };
  } catch {
    return { token: "", revocation: "", iss: false };
  }
};

export type FlowRow = {
  state_hash: string;
  user_id: string;
  enc_verifier: string;
  provider: string;
  connection_id: string;
  label: string;
  enc_url: string;
  issuer: string;
  resource: string;
  client_reg_id: string;
  scopes: string;
  redirect_uri: string;
  endpoints_json: string;
  created_at: number;
  expires_at: number;
};

const flowPlace = (stateHash: string, userId: string, field: "verifier" | "url"): SecretPlace => ({ id: stateHash, userId, provider: "connect-flow", field });

/** Opens what a flow sealed: its PKCE verifier and the server's address. */
export const flowSecret = (flow: FlowRow, field: "verifier" | "url") => unseal(field === "verifier" ? flow.enc_verifier : flow.enc_url, flowPlace(flow.state_hash, flow.user_id, field));

/**
 * Starts a sign-in: registers Flash where needed, stores the flow (10 minutes, single use, bound to
 * the user) and returns the authorization server's page to send the browser to.
 */
export async function beginSignIn(
  userId: string,
  o: {
    provider: string;
    serverUrl: string;
    label: string;
    origin: string;
    plan: SignInPlan;
    connectionId?: string;
    typed?: { clientId: string; clientSecret: string } | null;
    reuse?: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const redirectUri = callbackUrl(o.origin);
  const { server, resource, scopes } = o.plan;
  const client = await clientAt(userId, server, { origin: o.origin, redirectUri, typed: o.typed, reuse: o.reuse, signal: o.signal });
  const authorize = checkAuthorizeUrl(server.authorizationEndpoint);
  const state = randomId(24);
  const verifier = randomId(48);
  const stateHash = sha256(state);
  const at = now();
  const endpoints: Endpoints = { token: server.tokenEndpoint, revocation: server.revocationEndpoint, iss: server.issParameter };
  await (await db()).batch(
    [
      // Old flows go whenever a new one starts (Flash has no scheduled jobs).
      { sql: "DELETE FROM connect_flows WHERE expires_at < ?", args: [at] },
      {
        sql: `INSERT INTO connect_flows (state_hash, user_id, enc_verifier, provider, connection_id, label, enc_url, issuer, resource, client_reg_id, scopes, redirect_uri, endpoints_json, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          stateHash,
          userId,
          seal(verifier, flowPlace(stateHash, userId, "verifier")).stored,
          o.provider,
          o.connectionId ?? "",
          o.label.slice(0, 60),
          seal(o.serverUrl, flowPlace(stateHash, userId, "url")).stored,
          server.issuer,
          resource.resource,
          client.regId,
          scopes.join(" "),
          redirectUri,
          JSON.stringify(endpoints),
          at,
          at + FLOW_TTL_MS,
        ],
      },
    ],
    "write",
  );
  const params: Record<string, string> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: resource.resource,
    ...(scopes.length && { scope: scopes.join(" ") }),
  };
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v);
  return authorize.href;
}

/**
 * Takes a sign-in's flow, once: only the user who started it, only before it expires. Anyone else's
 * flow, an expired one or one already taken gives null, and nothing is stored.
 */
export async function takeFlow(userId: string, state: string | null): Promise<FlowRow | null> {
  if (!state || state.length > 200) return null;
  const taken = await run("DELETE FROM connect_flows WHERE state_hash = ? AND user_id = ? AND expires_at > ? RETURNING *", [sha256(state), userId, now()]);
  return (taken.rows[0] as unknown as FlowRow) ?? null;
}

/**
 * Whether the callback's iss is the authorization server the flow started with (RFC 9207, plain
 * string comparison). Every authorization server sends the browser back to the same callback, so
 * only iss tells whose code came back. A server the user added may run an authorization server that
 * sends the browser on to another one, which then answers without iss; its code would go to the first
 * one's token endpoint with the PKCE verifier (mix-up, RFC 9700 §4.4). So a flow for a server the user
 * added must carry iss, flows stored before this rule included. A preset's authorization server is
 * its vendor's own: one that says it doesn't send iss may leave it out.
 */
export function issMatches(flow: Pick<FlowRow, "issuer" | "endpoints_json" | "provider">, iss: string | null): boolean {
  if (iss === null) return flow.provider !== "custom" && !readEndpoints(flow.endpoints_json).iss;
  return iss === flow.issuer;
}

/** Refuses signing in to a server the user added when its authorization server doesn't say it sends iss (see issMatches). */
export function requireIss(provider: string, server: Pick<AuthServer, "issParameter">) {
  if (provider === "custom" && !server.issParameter) throw new OAuthError("no_iss", "That server's sign-in doesn't identify itself on the way back.");
}

export type Tokens = { access: string; refresh: string; expiresAt: number; scope: string };

const TOKEN_CHARS = /^[\x21-\x7e]{1,8192}$/;

/** A token endpoint's answer: tokens, or an OAuthError ("invalid_grant" when the grant or client is refused). Its own words are never kept. */
function readTokens(res: SafeResponse): Tokens {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: refused below.
  }
  if (res.status !== 200) {
    const error = typeof body.error === "string" ? body.error : "";
    if (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client") throw new OAuthError("invalid_grant");
    throw new OAuthError(res.status >= 500 ? "unreachable" : "token");
  }
  const access = body.access_token;
  if (typeof access !== "string" || !TOKEN_CHARS.test(access)) throw new OAuthError("token");
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") throw new OAuthError("token");
  const refresh = typeof body.refresh_token === "string" && TOKEN_CHARS.test(body.refresh_token) ? body.refresh_token : "";
  const seconds = Number(body.expires_in);
  return {
    access,
    refresh,
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? now() + Math.min(seconds, 400 * 24 * 3600) * 1000 : 0,
    scope: typeof body.scope === "string" ? scopeList(body.scope).join(" ") : "",
  };
}

/**
 * Sends a form to a token or revocation endpoint, with the client's authentication. A redirect is
 * never followed: the form holds a code and its verifier, a refresh token or a client secret, which
 * go only to the endpoint the authorization server's metadata named.
 */
async function postForm(url: string, client: OAuthClient, form: Record<string, string>, signal?: AbortSignal, timeoutMs = REQUEST_MS): Promise<SafeResponse> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.authMethod === "client_secret_basic" && client.secret) {
    // RFC 6749 §2.3.1: each part form-encoded, then Base64.
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
    headers.authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.secret)}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && client.secret) body.set("client_secret", client.secret);
  }
  const req: SafeRequest = { method: "POST", headers, body: body.toString(), accept: ["json"], maxBytes: TOKEN_MAX, timeoutMs, followRedirects: false, signal };
  try {
    return await safeFetch(url, req);
  } catch (err) {
    throw fetchProblem(err, signal);
  }
}

/** Trades the callback's code for tokens, with the flow's verifier, callback address and resource. */
export async function exchangeCode(userId: string, flow: FlowRow, code: string, signal?: AbortSignal): Promise<Tokens> {
  if (!code || code.length > 4096) throw new OAuthError("token");
  const client = await usableClient(userId, flow.client_reg_id);
  if (!client) throw new OAuthError("token");
  const endpoints = readEndpoints(flow.endpoints_json);
  const res = await postForm(
    endpoints.token,
    client,
    { grant_type: "authorization_code", code, redirect_uri: flow.redirect_uri, code_verifier: flowSecret(flow, "verifier"), resource: flow.resource },
    signal,
  );
  return readTokens(res);
}

/** A connection's grant, as refresh and revocation need it. */
export type Grant = { userId: string; clientRegId: string; resource: string; endpoints: Endpoints };

/** New tokens for a refresh token (the caller makes sure only one refresh runs per connection). */
export async function refreshGrant(grant: Grant, refreshToken: string, signal?: AbortSignal): Promise<Tokens> {
  const client = await usableClient(grant.userId, grant.clientRegId);
  if (!client) throw new OAuthError("invalid_grant");
  const res = await postForm(grant.endpoints.token, client, { grant_type: "refresh_token", refresh_token: refreshToken, resource: grant.resource }, signal);
  return readTokens(res);
}

/**
 * Asks the authorization server to cancel a connection's tokens (RFC 7009), the refresh token first,
 * where it has a revocation endpoint. Never throws: removing the account goes on either way.
 */
export async function revokeGrant(grant: Grant, tokens: { access: string; refresh: string }): Promise<boolean> {
  if (!grant.endpoints.revocation) return false;
  const client = await usableClient(grant.userId, grant.clientRegId).catch(() => null);
  if (!client) return false;
  const sent = [
    ...(tokens.refresh ? [{ token: tokens.refresh, token_type_hint: "refresh_token" }] : []),
    ...(tokens.access ? [{ token: tokens.access, token_type_hint: "access_token" }] : []),
  ];
  const answers = await Promise.allSettled(sent.map((form) => postForm(grant.endpoints.revocation, client, form, undefined, 5000)));
  return answers.some((a) => a.status === "fulfilled" && a.value.status === 200);
}
