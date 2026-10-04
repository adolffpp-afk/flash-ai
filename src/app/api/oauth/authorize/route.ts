import { appUrl, getUser } from "@/lib/server/auth.ts";
import { checkAuthorize, createCode, redirectWith } from "@/lib/server/connector.ts";

const see = (location: string) => new Response(null, { status: 303, headers: { Location: location } });

/** The user's answer on the "Connect to Flash" page: allow sends the app a one-time code. */
export async function POST(request: Request) {
  const origin = appUrl(request);
  // Only Flash's own page may answer (the session cookie is SameSite=Lax as well).
  const from = request.headers.get("origin");
  if (from && from !== origin && from !== new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const user = await getUser(request);
  const back = `/oauth/authorize?${new URLSearchParams(Object.entries(params).filter(([k]) => k !== "decision"))}`;
  if (!user) return see(back);
  const checked = await checkAuthorize(params, origin);
  if ("fatal" in checked) return see(back);
  if ("redirect" in checked) return see(checked.redirect);
  const { client, redirectUri, state, challenge } = checked.ok;
  if (params.decision !== "allow") return see(redirectWith(redirectUri, { error: "access_denied", state }, origin));
  const code = await createCode({ clientId: client.id, userId: user.id, redirectUri, challenge });
  return see(redirectWith(redirectUri, { code, state }, origin));
}
