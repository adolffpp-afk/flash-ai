import { db, now, one, run } from "./db.ts";
import { isAdmin } from "./auth.ts";
import { randomId, sha256 } from "./ids.ts";
import { pkceChallenge } from "./oauth.ts";
import { FLOW_TTL_MS, OAuthError, flowPlace, scopeList, type FlowRow, type Tokens } from "./mcp-oauth.ts";
import { mockOrigin, safeFetch, type SafeResponse } from "./safe-fetch.ts";
import { connectorsReady, seal } from "./secret-box.ts";

/*
 * Signing in to Figma and Canva through Flash's own app at each (an OAuth app Flash registers once, in
 * Figma's or Canva's developer settings), like Google Drive's through Flash's Google Cloud project.
 * Both take the standard authorization code flow with state and PKCE (S256), and a client secret that
 * goes only to the service's own token endpoint, in a Basic header. What differs is written down
 * per service below. The tools themselves are figma.ts and canva.ts; the connection is kept by
 * connections.ts (startApp, finishApp), like GitHub's and Google Drive's.
 *
 * A service is listed only once its two variables are set (and CONNECTOR_KEYS). Until Figma or Canva
 * has reviewed Flash's app, it works only for the account that made it, so it is offered to Flash's
 * owners only (FLASH_ADMIN_EMAILS); FIGMA_CONNECT_PUBLIC=true or CANVA_CONNECT_PUBLIC=true, set once the
 * review passed, offers it to everyone. Nothing here calls a model or moves credits.
 */

export type AppId = "figma" | "canva";

type AppService = {
  id: AppId;
  name: string;
  // The service's sign-in page, token and revocation endpoints (none: Figma has no way to cancel a grant).
  authorize: string;
  token: string;
  refresh: string;
  revoke: string;
  // Where its tools are called.
  api: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  // Set to "true" once the service has reviewed Flash's app: until then only Flash's owners see it.
  publicFlag: string;
  // Its token endpoint says a refresh token is refused only with a status (Figma), not with
  // OAuth's error code invalid_grant (Canva).
  refusedRefresh: (res: SafeResponse, body: Record<string, unknown>) => boolean;
};

const env = (name: string) => process.env[name]?.trim() ?? "";

/** A host of a service: its stand-in's when FLASH_CONNECT_MOCK is on (see scripts/mock-connectors.ts). */
const at = (id: AppId, part: "www" | "api", real: string, path = "") => (mockOrigin() ? `${mockOrigin()}/${id}/${part}${path}` : `${real}${path}`);

const SERVICES: Record<AppId, () => AppService> = {
  figma: () => ({
    id: "figma",
    name: "Figma",
    authorize: at("figma", "www", "https://www.figma.com", "/oauth"),
    token: at("figma", "api", "https://api.figma.com", "/v1/oauth/token"),
    refresh: at("figma", "api", "https://api.figma.com", "/v1/oauth/refresh"),
    revoke: "",
    api: at("figma", "api", "https://api.figma.com"),
    // Who the account is, and reading the files the user links to (nodes and pictures): nothing that writes.
    scopes: ["current_user:read", "file_content:read"],
    clientId: "FIGMA_CONNECT_CLIENT_ID",
    clientSecret: "FIGMA_CONNECT_CLIENT_SECRET",
    publicFlag: "FIGMA_CONNECT_PUBLIC",
    // Figma answers a refresh token it doesn't take with 400 (a wrong client secret is 401 or 403, which
    // isn't the user's grant ending, so it sends nobody to Reconnect).
    refusedRefresh: (res, body) => res.status === 400 || body.error === "invalid_grant",
  }),
  canva: () => ({
    id: "canva",
    name: "Canva",
    authorize: at("canva", "www", "https://www.canva.com", "/api/oauth/authorize"),
    token: at("canva", "api", "https://api.canva.com", "/rest/v1/oauth/token"),
    refresh: at("canva", "api", "https://api.canva.com", "/rest/v1/oauth/token"),
    revoke: at("canva", "api", "https://api.canva.com", "/rest/v1/oauth/revoke"),
    api: at("canva", "api", "https://api.canva.com", "/rest"),
    // Find and read the user's designs (export them), add pictures to their uploads and make new designs.
    scopes: ["profile:read", "design:meta:read", "design:content:read", "design:content:write", "asset:read", "asset:write"],
    clientId: "CANVA_CONNECT_CLIENT_ID",
    clientSecret: "CANVA_CONNECT_CLIENT_SECRET",
    publicFlag: "CANVA_CONNECT_PUBLIC",
    refusedRefresh: (_res, body) => body.error === "invalid_grant",
  }),
};

export const appService = (id: AppId): AppService => SERVICES[id]();

/** The provider ids (connections.provider, connect_flows.provider) of the services here. */
export const APP_IDS: AppId[] = ["figma", "canva"];
export const isAppId = (value: string): value is AppId => (APP_IDS as string[]).includes(value);

/** The environment variables a service needs (never their values): until both are set (and CONNECTOR_KEYS), it is hidden everywhere. */
export const appKeys = (id: AppId) => [appService(id).clientId, appService(id).clientSecret];
export const appMissing = (id: AppId) => appKeys(id).filter((name) => !env(name));

/** Whether a service can be used at all: connectors are set up and so is Flash's app there. */
export const appReady = (id: AppId) => connectorsReady() && appMissing(id).length === 0;

/** Whether the service's review of Flash's app passed (its PUBLIC variable), so everyone may connect it. */
export const appPublic = (id: AppId) => env(appService(id).publicFlag).toLowerCase() === "true";

/** Whether this user may connect the service: it is set up, and either reviewed or they are one of Flash's owners. */
export const appOpenTo = (id: AppId, user: Parameters<typeof isAdmin>[0]) => appReady(id) && (appPublic(id) || isAdmin(user));

/** Where the service sends the browser back: the redirect URL registered in Flash's app there. */
export const appCallbackUrl = (id: AppId, origin: string) => `${origin}/api/connect/${id}/callback`;

const TOKEN_MS = 10_000;
const REVOKE_MS = 5000;
const TOKEN_MAX = 64 * 1024;
const TOKEN_CHARS = /^[\x21-\x7e]{1,8192}$/;

/**
 * Starts a flow (10 minutes, single use, bound to the user; for Reconnect, the connection it renews)
 * and returns the service's sign-in page to send the browser to.
 */
export async function beginAppFlow(id: AppId, userId: string, origin: string, { connectionId = "" }: { connectionId?: string } = {}): Promise<string> {
  const service = appService(id);
  const state = randomId(24);
  const verifier = randomId(48);
  const stateHash = sha256(state);
  const redirectUri = appCallbackUrl(id, origin);
  const time = now();
  await (await db()).batch(
    [
      { sql: "DELETE FROM connect_flows WHERE expires_at < ?", args: [time] },
      {
        sql: `INSERT INTO connect_flows (state_hash, user_id, enc_verifier, provider, connection_id, label, enc_url, issuer, resource, client_reg_id, scopes, redirect_uri, endpoints_json, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, '', ?, '', '', ?, ?, '{}', ?, ?)`,
        args: [stateHash, userId, seal(verifier, flowPlace(stateHash, userId, "verifier")).stored, id, connectionId, service.name, new URL(service.authorize).origin, service.scopes.join(" "), redirectUri, time, time + FLOW_TTL_MS],
      },
    ],
    "write",
  );
  const page = new URL(service.authorize);
  page.searchParams.set("client_id", env(service.clientId));
  page.searchParams.set("redirect_uri", redirectUri);
  page.searchParams.set("response_type", "code");
  page.searchParams.set("scope", service.scopes.join(" "));
  page.searchParams.set("state", state);
  page.searchParams.set("code_challenge", pkceChallenge(verifier));
  page.searchParams.set("code_challenge_method", "S256");
  return page.href;
}

/** Who started a sign-in to this service for a state that is still under way (null for none). */
export async function appFlowOwner(id: AppId, state: string | null): Promise<string | null> {
  if (!state || state.length > 200) return null;
  const row = await one<{ user_id: string }>("SELECT user_id FROM connect_flows WHERE state_hash = ? AND provider = ? AND expires_at > ?", [sha256(state), id, now()]);
  return row?.user_id ?? null;
}

/** Takes the user's own flow to this service for a state, once, before it expires (no other callback takes it). */
export async function takeAppFlow(id: AppId, userId: string, state: string | null): Promise<FlowRow | null> {
  if (!state || state.length > 200) return null;
  const taken = await run("DELETE FROM connect_flows WHERE state_hash = ? AND user_id = ? AND provider = ? AND expires_at > ? RETURNING *", [sha256(state), userId, id, now()]);
  return (taken.rows[0] as unknown as FlowRow) ?? null;
}

/** Tokens, with the account id Figma sends with them at sign-in (user_id_string; "" from Canva). */
export type AppTokens = Tokens & { accountId: string };

const bodyOf = (res: SafeResponse): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(res.body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** A token answer: tokens, or an OAuthError. The service's own words are never kept. */
function readTokens(res: SafeResponse, refusedGrant: boolean): AppTokens {
  const body = bodyOf(res);
  if (res.status !== 200) {
    if (refusedGrant) throw new OAuthError("invalid_grant");
    throw new OAuthError(res.status >= 500 ? "unreachable" : "token");
  }
  const access = body.access_token;
  if (typeof access !== "string" || !TOKEN_CHARS.test(access)) throw new OAuthError("token");
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") throw new OAuthError("token");
  const refresh = typeof body.refresh_token === "string" && TOKEN_CHARS.test(body.refresh_token) ? body.refresh_token : "";
  const seconds = Number(body.expires_in);
  const account = body.user_id_string ?? body.user_id;
  return {
    access,
    refresh,
    // Figma's last 90 days, Canva's 4 hours.
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? now() + Math.min(seconds, 90 * 24 * 3600) * 1000 : 0,
    scope: typeof body.scope === "string" ? scopeList(body.scope.replace(/,/g, " ")).join(" ") : "",
    accountId: (typeof account === "string" || typeof account === "number") && /^[\w-]{1,64}$/.test(String(account)) ? String(account) : "",
  };
}

/** A form to one of the service's token endpoints, with Flash's client ID and secret in a Basic header. Never follows a redirect: it holds a secret. */
async function postForm(service: AppService, url: string, form: Record<string, string>, timeoutMs = TOKEN_MS): Promise<SafeResponse> {
  const basic = Buffer.from(`${env(service.clientId)}:${env(service.clientSecret)}`).toString("base64");
  try {
    return await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
      body: new URLSearchParams(form).toString(),
      accept: ["json"],
      maxBytes: TOKEN_MAX,
      timeoutMs,
      followRedirects: false,
    });
  } catch {
    throw new OAuthError("unreachable", `${service.name} couldn't be reached.`);
  }
}

/** Trades the sign-in's code for the user's tokens, with the flow's PKCE verifier. */
export async function exchangeAppCode(id: AppId, code: string, verifier: string, redirectUri: string): Promise<AppTokens> {
  if (!code || code.length > 4096 || !TOKEN_CHARS.test(code)) throw new OAuthError("token");
  const service = appService(id);
  const res = await postForm(service, service.token, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  return readTokens(res, false);
}

/**
 * New tokens for a refresh token. Figma keeps the same refresh token (and ends the old access token);
 * Canva sends a new one each time and takes each only once, which connections.ts keeps in one write.
 */
export async function refreshAppToken(id: AppId, refresh: string): Promise<Tokens> {
  const service = appService(id);
  const form: Record<string, string> = id === "figma" ? { refresh_token: refresh } : { grant_type: "refresh_token", refresh_token: refresh };
  const res = await postForm(service, service.refresh, form);
  return readTokens(res, res.status !== 200 && service.refusedRefresh(res, bodyOf(res)));
}

/** Whether the service lets Flash cancel the access the user gave it (Canva does; Figma has no such endpoint). */
export const appRevocable = (id: AppId) => appService(id).revoke !== "";

/** Asks the service to cancel a token (Canva cancels the refresh token's whole line with it). Never throws; true when it confirmed it. */
export async function revokeAppToken(id: AppId, token: string): Promise<boolean> {
  const service = appService(id);
  if (!token || !service.revoke || appMissing(id).length) return false;
  try {
    const res = await postForm(service, service.revoke, { token }, REVOKE_MS);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** The account a token is for: its stable id and a name to show (Figma: the email; Canva: the display name). Null when the service doesn't say. */
export type AppAccount = { id: string; label: string };

const ACCOUNT_ID = /^[\w-]{1,64}$/;
const oneLine = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

async function getJson(url: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await safeFetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, accept: ["json"], maxBytes: TOKEN_MAX, timeoutMs: TOKEN_MS });
  return { status: res.status, body: bodyOf(res) };
}

/** Who signed in, asked of the service with the new token. */
export async function appAccount(id: AppId, token: string): Promise<AppAccount | null> {
  const service = appService(id);
  try {
    if (id === "figma") {
      const me = await getJson(`${service.api}/v1/me`, token);
      const account = String(me.body.id ?? "");
      if (me.status !== 200 || !ACCOUNT_ID.test(account)) return null;
      return { id: account, label: oneLine(me.body.email, 254) || oneLine(me.body.handle, 100) };
    }
    const me = await getJson(`${service.api}/v1/users/me`, token);
    const user = me.body.team_user && typeof me.body.team_user === "object" ? (me.body.team_user as Record<string, unknown>) : {};
    const account = String(user.user_id ?? "");
    if (me.status !== 200 || !ACCOUNT_ID.test(account)) return null;
    // The name is only for Settings: without it the account is still known by its id.
    const profile = await getJson(`${service.api}/v1/users/me/profile`, token).catch(() => null);
    const name = profile?.status === 200 && profile.body.profile && typeof profile.body.profile === "object" ? (profile.body.profile as Record<string, unknown>).display_name : "";
    return { id: account, label: oneLine(name, 100) };
  } catch {
    return null;
  }
}
