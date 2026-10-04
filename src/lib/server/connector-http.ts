import { appUrl } from "./auth.ts";

/**
 * HTTP pieces of the Flash connector. The connector's endpoints use tokens, never cookies, so
 * any website may call them (browser-based MCP clients need that).
 */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", ...headers } });
}

/** An OAuth error (RFC 6749 section 5.2). */
export const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

export const mcpUrl = (request: Request) => `${appUrl(request)}/mcp`;

/** How an app finds Flash's sign-in (RFC 8414). */
export function authorizationServerMetadata(request: Request) {
  const origin = appUrl(request);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["flash"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/connector`,
  };
}

/** What the /mcp endpoint is and who signs people in to it (RFC 9728). */
export function protectedResourceMetadata(request: Request) {
  const origin = appUrl(request);
  return {
    resource: mcpUrl(request),
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["flash"],
    resource_name: "Flash AI",
    resource_documentation: `${origin}/connector`,
  };
}

/** The reply to a request without a working token, telling the app where to sign in. */
export function needsSignIn(request: Request, error?: "invalid_token"): Response {
  const meta = `${appUrl(request)}/.well-known/oauth-protected-resource/mcp`;
  return json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Sign in to Flash to use this connector." } },
    401,
    { "WWW-Authenticate": `Bearer resource_metadata="${meta}"${error ? `, error="${error}"` : ""}` },
  );
}
