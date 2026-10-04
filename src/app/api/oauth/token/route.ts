import { clientAuthenticates, issueTokens, redeemCode, refreshTokens } from "@/lib/server/connector.ts";
import { json, oauthError, preflight } from "@/lib/server/connector-http.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";

/** The app's id and secret, from the form or from HTTP Basic auth. */
function clientCredentials(request: Request, form: URLSearchParams): { id: string; secret: string | null } {
  const basic = request.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
    return { id: decodeURIComponent(id ?? ""), secret: secret ? decodeURIComponent(secret) : null };
  }
  return { id: form.get("client_id") ?? "", secret: form.get("client_secret") };
}

/** Swaps an approval code, or a refresh token, for tokens. */
export async function POST(request: Request) {
  if (await overLimit(`oauth-token:${clientIp(request)}`, 120, 600_000)) {
    return oauthError("slow_down", "Too many requests. Try again in a few minutes.", 429);
  }
  const type = request.headers.get("content-type") ?? "";
  const form = type.includes("application/json")
    ? new URLSearchParams((await request.json().catch(() => ({}))) as Record<string, string>)
    : new URLSearchParams(await request.text());
  const client = clientCredentials(request, form);
  if (!client.id || !(await clientAuthenticates(client.id, client.secret))) {
    return oauthError("invalid_client", "Unknown app, or a wrong secret.", 401);
  }
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const userId = await redeemCode(form.get("code") ?? "", client.id, form.get("redirect_uri") ?? "", form.get("code_verifier") ?? "");
    if (!userId) return oauthError("invalid_grant", "The code is wrong, used or expired. Please connect again.");
    return json(await issueTokens(client.id, userId));
  }
  if (grant === "refresh_token") {
    const tokens = await refreshTokens(form.get("refresh_token") ?? "", client.id);
    if (!tokens) return oauthError("invalid_grant", "This sign-in has ended. Please connect Flash again.");
    return json(tokens);
  }
  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export const OPTIONS = preflight;
