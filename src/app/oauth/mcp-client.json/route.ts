import { appUrl } from "@/lib/server/auth.ts";
import { clientMetadata } from "@/lib/server/mcp-oauth.ts";

/*
 * Flash's Client ID Metadata Document: an authorization server that takes one (MCP 2025-11-25 and
 * later) reads who Flash is from this address, which is also Flash's client_id there, so Flash needs
 * no registration with it. Public, with no secrets: Flash is a public client using PKCE.
 */
export function GET(request: Request) {
  return Response.json(clientMetadata(appUrl(request)), { headers: { "Cache-Control": "public, max-age=3600" } });
}
