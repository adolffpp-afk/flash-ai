/*
 * "Continue with Google / GitHub / Microsoft": the OAuth 2.0 authorization-code flow with PKCE,
 * written with fetch. Each provider shows only when its client id and secret are set.
 *
 * The browser keeps the state, PKCE verifier and nonce in a short-lived HttpOnly cookie that is
 * only sent to /api/auth/oauth, and the callback checks the returned state against it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { randomId } from "./ids.ts";

export type ProviderId = "google" | "github" | "microsoft";

type Provider = {
  name: string;
  env: string;
  authorize: string;
  token: string;
  scope: string;
  // Extra parameters for the sign-in page.
  params?: Record<string, string>;
};

// Personal Microsoft accounts all belong to this tenant, and Microsoft has confirmed their email.
const MSA_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export const PROVIDERS: Record<ProviderId, Provider> = {
  google: {
    name: "Google",
    env: "GOOGLE",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    params: { prompt: "select_account" },
  },
  github: {
    name: "GitHub",
    env: "GITHUB",
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
  microsoft: {
    name: "Microsoft",
    env: "MICROSOFT",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid email profile",
    params: { prompt: "select_account", response_mode: "query" },
  },
};

export const isProvider = (id: string): id is ProviderId => Object.hasOwn(PROVIDERS, id);

function credentials(id: ProviderId): { clientId: string; clientSecret: string } | null {
  const env = PROVIDERS[id].env;
  const clientId = process.env[`${env}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${env}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** The providers whose client id and secret are set, in the order the buttons show. */
export const enabledProviders = (): ProviderId[] =>
  (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => credentials(id));

export const callbackUrl = (origin: string, id: ProviderId) => `${origin}/api/auth/oauth/${id}/callback`;

/** Only paths on this site, so a crafted link can't send people elsewhere after signing in. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  // Control characters could turn the path into something a browser reads differently.
  if ([...next].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return "/";
  return next.slice(0, 500);
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export type OAuthState = { provider: ProviderId; state: string; verifier: string; nonce: string; next: string; expires: number };

export const OAUTH_COOKIE = "flash_oauth";
const STATE_MINUTES = 10;

/** A fresh state, PKCE verifier and nonce for one sign-in attempt. */
export function newState(provider: ProviderId, next: string | null, now = Date.now()): OAuthState {
  return {
    provider,
    state: randomId(24),
    verifier: randomId(48),
    nonce: randomId(24),
    next: safeNext(next),
    expires: now + STATE_MINUTES * 60_000,
  };
}

export function stateCookie(s: OAuthState, secure: boolean): string {
  const value = b64url(Buffer.from(JSON.stringify(s)));
  return `${OAUTH_COOKIE}=${value}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=${STATE_MINUTES * 60}${secure ? "; Secure" : ""}`;
}

export const clearStateCookie = () => `${OAUTH_COOKIE}=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0`;

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The saved attempt when the cookie is intact, belongs to this provider, hasn't expired and its
 * state matches the one the provider sent back. Anything else is null.
 */
export function checkState(
  cookie: string | null,
  provider: ProviderId,
  returned: string | null,
  now = Date.now(),
): OAuthState | null {
  if (!cookie || !returned) return null;
  let s: Partial<OAuthState>;
  try {
    s = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!s || typeof s !== "object") return null;
  if (s.provider !== provider || typeof s.state !== "string" || typeof s.verifier !== "string") return null;
  if (typeof s.nonce !== "string" || typeof s.expires !== "number" || s.expires < now) return null;
  if (s.verifier.length < 43 || !sameString(s.state, returned)) return null;
  return { ...(s as OAuthState), next: safeNext(s.next) };
}

/** Where to send the browser to sign in with the provider. */
export function authorizeUrl(s: OAuthState, origin: string): string | null {
  const creds = credentials(s.provider);
  if (!creds) return null;
  const p = PROVIDERS[s.provider];
  const url = new URL(p.authorize);
  const params: Record<string, string> = {
    client_id: creds.clientId,
    redirect_uri: callbackUrl(origin, s.provider),
    response_type: "code",
    scope: p.scope,
    state: s.state,
    code_challenge: pkceChallenge(s.verifier),
    code_challenge_method: "S256",
    ...(s.provider === "github" ? {} : { nonce: s.nonce }),
    ...p.params,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export type Profile = { provider: ProviderId; subject: string; email: string; emailVerified: boolean; name: string };

/** Errors that are safe to log: never include tokens, codes or secrets. */
class SignInError extends Error {}

type Claims = Record<string, unknown>;

export function decodeJwtPayload(jwt: string): Claims | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

const SKEW = 5 * 60;

/**
 * Checks an ID token's claims and reads the person from it. The token comes straight from the
 * provider's token endpoint over TLS, which OpenID Connect accepts in place of a signature check;
 * issuer, audience, expiry and the nonce from this attempt are still checked.
 */
export function profileFromClaims(
  provider: "google" | "microsoft",
  claims: Claims,
  expect: { clientId: string; nonce: string },
  now = Date.now(),
): Profile {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const aud = claims.aud;
  if (!(aud === expect.clientId || (Array.isArray(aud) && aud.includes(expect.clientId)))) {
    throw new SignInError("id_token audience mismatch");
  }
  if (typeof claims.exp !== "number" || claims.exp + SKEW < now / 1000) throw new SignInError("id_token expired");
  if (!str(claims.nonce) || !sameString(str(claims.nonce), expect.nonce)) throw new SignInError("id_token nonce mismatch");
  const subject = str(claims.sub);
  if (!subject) throw new SignInError("id_token has no subject");

  if (provider === "google") {
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
      throw new SignInError("id_token issuer mismatch");
    }
    const email = str(claims.email).trim().toLowerCase();
    const verified = claims.email_verified === true || claims.email_verified === "true";
    return { provider, subject, email, emailVerified: Boolean(email) && verified, name: str(claims.name) };
  }

  // Microsoft's shared "common" endpoint: the issuer names the person's own tenant.
  const tid = str(claims.tid);
  if (!tid || claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new SignInError("id_token issuer mismatch");
  // Work and school accounts' email is typed in by their admin, so it only counts as confirmed for
  // personal accounts, or when Microsoft says the domain's owner confirmed it (the xms_edov claim).
  const email = str(claims.email).trim().toLowerCase();
  const verified = tid === MSA_TENANT || claims.xms_edov === true || claims.xms_edov === "1" || claims.xms_edov === "true";
  return { provider, subject, email, emailVerified: Boolean(email) && verified, name: str(claims.name) };
}

async function postToken(id: ProviderId, code: string, verifier: string, origin: string) {
  const creds = credentials(id);
  if (!creds) throw new SignInError("provider not configured");
  const res = await fetch(PROVIDERS[id].token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(origin, id),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error?: string };
  if (!res.ok || data.error || !data.access_token) {
    // Only the status and the provider's error code; the response may echo the code or tokens.
    throw new SignInError(`token endpoint returned ${res.status} ${String(data.error ?? "").slice(0, 60)}`.trim());
  }
  return { ...data, clientId: creds.clientId } as { access_token: string; id_token?: string; clientId: string };
}

async function githubGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Flash AI" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new SignInError(`GitHub ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/** Trades the code from the callback for the person's provider id, email and name. */
export async function fetchProfile(s: OAuthState, code: string, origin: string): Promise<Profile> {
  const tokens = await postToken(s.provider, code, s.verifier, origin);
  if (s.provider === "github") {
    const user = await githubGet<{ id: number; login: string; name: string | null }>("/user", tokens.access_token);
    const emails = await githubGet<{ email: string; primary: boolean; verified: boolean }[]>("/user/emails", tokens.access_token);
    const primary = emails.find((e) => e.primary);
    return {
      provider: "github",
      subject: String(user.id),
      email: (primary?.email ?? "").trim().toLowerCase(),
      emailVerified: Boolean(primary?.verified),
      name: user.name || user.login || "",
    };
  }
  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  if (!claims) throw new SignInError("no id_token");
  return profileFromClaims(s.provider, claims, { clientId: tokens.clientId, nonce: s.nonce });
}
