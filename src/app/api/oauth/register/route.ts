import { registerClient } from "@/lib/server/connector.ts";
import { json, oauthError, preflight } from "@/lib/server/connector-http.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";

/** Dynamic client registration (RFC 7591): how an app like Claude introduces itself to Flash. */
export async function POST(request: Request) {
  if (await overLimit(`oauth-register:${clientIp(request)}`, 30, 3600_000)) {
    return oauthError("slow_down", "Too many registrations. Try again in an hour.", 429);
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return oauthError("invalid_client_metadata", "Send the app's details as JSON.");
  const result = await registerClient(body);
  if ("error" in result) return oauthError("invalid_redirect_uri", result.error);
  const { client, secret } = result;
  return json(
    {
      client_id: client.id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: secret ? (body.token_endpoint_auth_method as string) : "none",
    },
    201,
  );
}

export const OPTIONS = preflight;
