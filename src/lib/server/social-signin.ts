import { db, now, one, run } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { pkceChallenge } from "./oauth.ts";
import { FLOW_TTL_MS, OAuthError, flowPlace, flowSecret, scopeList, type FlowRow, type Tokens } from "./mcp-oauth.ts";
import { mockOrigin, safeFetch, type SafeResponse } from "./safe-fetch.ts";
import { connectorsReady, seal } from "./secret-box.ts";
import type { NetworkId } from "../social.ts";

/*
 * Signing in to X, YouTube, Google Business Profile and Pinterest for the Social hub, through
 * Flash's own app at each (registered once by Flash's owner; see docs/social-setup.md). The standard
 * authorization code flow: a state bound to the user and kept hashed in connect_flows (10 minutes,
 * single use), PKCE S256 where the network takes it (all but Pinterest, which doesn't document it;
 * its client secret and the state stand in), and the client secret sent only to the network's own
 * token endpoint, never following a redirect. One redirect URL for every network,
 * <origin>/api/social/callback: the flow's row says which network it was for, so a code is only
 * ever traded with the network the user started.
 *
 * YouTube and Google Business Profile share one Google Cloud project of Flash's own (not the one
 * Google Drive uses, whose verification is done and stays untouched). Nothing here calls a model or
 * moves credits.
 */

export type SigninNetwork = Extract<NetworkId, "x" | "youtube" | "google-business" | "pinterest">;
export const SIGNIN_NETWORKS: SigninNetwork[] = ["x", "youtube", "google-business", "pinterest"];
export const isSigninNetwork = (id: string): id is SigninNetwork => (SIGNIN_NETWORKS as string[]).includes(id);

type Service = {
  authorize: string;
  token: string;
  revoke: string;
  scopes: string[];
  // How the scopes are joined in the sign-in page's address (Pinterest takes commas).
  scopeJoin: string;
  clientId: string;
  clientSecret: string;
  // Where the client's secret goes to the token endpoint: a Basic header, or the form (Google).
  auth: "basic" | "form";
  pkce: boolean;
  extra: Record<string, string>;
};

const env = (name: string) => process.env[name]?.trim() ?? "";

/** A network's host, or its stand-in's when FLASH_CONNECT_MOCK is on (tests and local trying only). */
export const socialHost = (network: string, real: string) => (mockOrigin() ? `${mockOrigin()}/social/${network}/${new URL(real).hostname}` : real);

const GOOGLE_SCOPES = { youtube: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"], "google-business": ["https://www.googleapis.com/auth/business.manage"] };

function service(network: SigninNetwork): Service {
  if (network === "x") {
    return {
      authorize: `${socialHost("x", "https://x.com")}/i/oauth2/authorize`,
      token: `${socialHost("x", "https://api.x.com")}/2/oauth2/token`,
      revoke: `${socialHost("x", "https://api.x.com")}/2/oauth2/revoke`,
      // Read and write posts, who the account is, pictures, and a refresh token (offline.access).
      scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
      scopeJoin: " ",
      clientId: "SOCIAL_X_CLIENT_ID",
      clientSecret: "SOCIAL_X_CLIENT_SECRET",
      auth: "basic",
      pkce: true,
      extra: {},
    };
  }
  if (network === "pinterest") {
    return {
      authorize: `${socialHost("pinterest", "https://www.pinterest.com")}/oauth/`,
      token: `${socialHost("pinterest", "https://api.pinterest.com")}/v5/oauth/token`,
      revoke: "",
      scopes: ["user_accounts:read", "boards:read", "pins:read", "pins:write"],
      scopeJoin: ",",
      clientId: "SOCIAL_PINTEREST_CLIENT_ID",
      clientSecret: "SOCIAL_PINTEREST_CLIENT_SECRET",
      auth: "basic",
      pkce: false,
      extra: {},
    };
  }
  return {
    authorize: `${socialHost(network, "https://accounts.google.com")}/o/oauth2/v2/auth`,
    token: `${socialHost(network, "https://oauth2.googleapis.com")}/token`,
    revoke: `${socialHost(network, "https://oauth2.googleapis.com")}/revoke`,
    // openid: Google's id for the account (its sub), so connecting the same account again updates it.
    scopes: ["openid", ...GOOGLE_SCOPES[network]],
    scopeJoin: " ",
    clientId: "SOCIAL_GOOGLE_CLIENT_ID",
    clientSecret: "SOCIAL_GOOGLE_CLIENT_SECRET",
    auth: "form",
    pkce: true,
    // A refresh token every time (a post scheduled for next month must still go out).
    extra: { access_type: "offline", prompt: "consent" },
  };
}

/** The environment variables a network's sign-in needs (never their values). */
export const signinKeys = (network: SigninNetwork) => [service(network).clientId, service(network).clientSecret];
export const signinMissing = (network: SigninNetwork) => signinKeys(network).filter((name) => !env(name));
/** Whether a network's sign-in is set up (and CONNECTOR_KEYS, which seals its tokens). */
export const signinReady = (network: SigninNetwork) => connectorsReady() && signinMissing(network).length === 0;

/** The one address every network sends the browser back to. */
export const socialCallbackUrl = (origin: string) => `${origin}/api/social/callback`;

const flowProvider = (network: SigninNetwork) => `social-${network}`;

/** Starts a sign-in (10 minutes, single use, bound to the user) and returns the network's page to send the browser to. */
export async function beginSocialFlow(network: SigninNetwork, userId: string, origin: string): Promise<string> {
  const s = service(network);
  const state = randomId(24);
  const verifier = randomId(48);
  const stateHash = sha256(state);
  const redirectUri = socialCallbackUrl(origin);
  const time = now();
  await (await db()).batch(
    [
      { sql: "DELETE FROM connect_flows WHERE expires_at < ?", args: [time] },
      {
        sql: `INSERT INTO connect_flows (state_hash, user_id, enc_verifier, provider, connection_id, label, enc_url, issuer, resource, client_reg_id, scopes, redirect_uri, endpoints_json, created_at, expires_at)
              VALUES (?, ?, ?, ?, '', '', '', ?, '', '', ?, ?, '{}', ?, ?)`,
        args: [stateHash, userId, seal(verifier, flowPlace(stateHash, userId, "verifier")).stored, flowProvider(network), new URL(s.authorize).origin, s.scopes.join(" "), redirectUri, time, time + FLOW_TTL_MS],
      },
    ],
    "write",
  );
  const page = new URL(s.authorize);
  page.searchParams.set("client_id", env(s.clientId));
  page.searchParams.set("redirect_uri", redirectUri);
  page.searchParams.set("response_type", "code");
  page.searchParams.set("scope", s.scopes.join(s.scopeJoin));
  page.searchParams.set("state", state);
  if (s.pkce) {
    page.searchParams.set("code_challenge", pkceChallenge(verifier));
    page.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(s.extra)) page.searchParams.set(k, v);
  return page.href;
}

/** Who started the sign-in for a state still under way, and to which network (null for none). */
export async function socialFlowOwner(state: string | null): Promise<{ userId: string; network: SigninNetwork } | null> {
  if (!state || state.length > 200) return null;
  const row = await one<{ user_id: string; provider: string }>("SELECT user_id, provider FROM connect_flows WHERE state_hash = ? AND provider LIKE 'social-%' AND expires_at > ?", [sha256(state), now()]);
  const network = row?.provider.slice("social-".length) ?? "";
  return row && isSigninNetwork(network) ? { userId: row.user_id, network } : null;
}

/** Takes the user's own flow for a state, once, before it expires, with its network and PKCE verifier. */
export async function takeSocialFlow(userId: string, state: string | null): Promise<{ network: SigninNetwork; verifier: string; redirectUri: string } | null> {
  if (!state || state.length > 200) return null;
  const taken = await run("DELETE FROM connect_flows WHERE state_hash = ? AND user_id = ? AND provider LIKE 'social-%' AND expires_at > ? RETURNING *", [sha256(state), userId, now()]);
  const flow = taken.rows[0] as unknown as FlowRow | undefined;
  const network = flow?.provider.slice("social-".length) ?? "";
  if (!flow || !isSigninNetwork(network)) return null;
  return { network, verifier: flowSecret(flow, "verifier"), redirectUri: flow.redirect_uri };
}

const TOKEN_MS = 10_000;
const TOKEN_MAX = 64 * 1024;
const TOKEN_CHARS = /^[\x21-\x7e]{1,8192}$/;

export const bodyOf = (res: SafeResponse): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(res.body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Tokens, with Google's id token's account (its sub) when there is one. */
export type SocialTokens = Tokens & { idToken: string };

function readTokens(res: SafeResponse): SocialTokens {
  const body = bodyOf(res);
  if (res.status !== 200) {
    if (body.error === "invalid_grant" || (res.status === 400 && /invalid|expired|revoked/i.test(String(body.error ?? "")))) throw new OAuthError("invalid_grant");
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
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? now() + Math.min(seconds, 90 * 24 * 3600) * 1000 : 0,
    scope: typeof body.scope === "string" ? scopeList(body.scope.replace(/,/g, " ")).join(" ") : "",
    idToken: typeof body.id_token === "string" && body.id_token.length < 8192 ? body.id_token : "",
  };
}

async function postForm(s: Service, url: string, form: Record<string, string>): Promise<SafeResponse> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const fields = { ...form };
  if (s.auth === "basic") headers.authorization = `Basic ${Buffer.from(`${env(s.clientId)}:${env(s.clientSecret)}`).toString("base64")}`;
  else Object.assign(fields, { client_id: env(s.clientId), client_secret: env(s.clientSecret) });
  // X wants its client id in the form too, for a confidential client.
  if (s.auth === "basic" && s.clientId === "SOCIAL_X_CLIENT_ID") fields.client_id = env(s.clientId);
  try {
    return await safeFetch(url, { method: "POST", headers, body: new URLSearchParams(fields).toString(), accept: ["json"], maxBytes: TOKEN_MAX, timeoutMs: TOKEN_MS, followRedirects: false });
  } catch {
    throw new OAuthError("unreachable", "The network couldn't be reached.");
  }
}

/** Trades the sign-in's code for the user's tokens (with the flow's PKCE verifier where the network takes PKCE). */
export async function exchangeSocialCode(network: SigninNetwork, code: string, verifier: string, redirectUri: string): Promise<SocialTokens> {
  if (!code || code.length > 4096 || !TOKEN_CHARS.test(code)) throw new OAuthError("token");
  const s = service(network);
  return readTokens(await postForm(s, s.token, { grant_type: "authorization_code", code, redirect_uri: redirectUri, ...(s.pkce && { code_verifier: verifier }) }));
}

/** New tokens for a refresh token (X's and Pinterest's may come with a new one, which the caller keeps in one write). */
export async function refreshSocialToken(network: SigninNetwork, refresh: string): Promise<Tokens> {
  const s = service(network);
  return readTokens(await postForm(s, s.token, { grant_type: "refresh_token", refresh_token: refresh }));
}

/** Asks the network to cancel a token, where it can (X, Google). Never throws; true when it confirmed it. */
export async function revokeSocialToken(network: SigninNetwork, token: string): Promise<boolean> {
  const s = service(network);
  if (!token || !s.revoke || signinMissing(network).length) return false;
  try {
    const res = await postForm(s, s.revoke, { token, ...(network === "x" && { token_type_hint: "refresh_token" }) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Google's account id (sub) from the id token the token endpoint just sent over TLS (its signature isn't needed for that). */
export function googleSub(idToken: string): string {
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown; iss?: unknown };
    const sub = String(claims.sub ?? "");
    return /^\d{1,64}$/.test(sub) || (mockOrigin() && /^[\w-]{1,64}$/.test(sub)) ? sub : "";
  } catch {
    return "";
  }
}
