import { ACCOUNT_ID, appUrl, jarSessions } from "@/lib/server/auth.ts";
import { checkAuthorize, createCode, redirectWith } from "@/lib/server/connector.ts";
import { sameSite } from "@/lib/server/connector-http.ts";

const OWN_FIELDS = ["account", "decision", "changed"];

const see = (location: string) => new Response(null, { status: 303, headers: { Location: location } });

/**
 * The user's answer on the "Connect to Flash" page: allow sends the app a one-time code, for the
 * account the page showed (its account field). When that account isn't signed in here anymore, or
 * the browser holds several and the page named none, the page is shown again and nothing is made.
 */
export async function POST(request: Request) {
  const origin = appUrl(request);
  // Only Flash's own page may answer (see sameSite).
  if (!sameSite(request.headers.get("origin"), request, origin)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const { account, decision } = fields;
  // The app's own parameters, without Flash's: the answer, the account, and the page's notice.
  const params = Object.fromEntries(Object.entries(fields).filter(([k]) => !OWN_FIELDS.includes(k)));
  const back = `/oauth/authorize?${new URLSearchParams(params)}`;
  const jar = await jarSessions(request);
  // A page from before accounts could be switched names none: the browser's one account, as then.
  const user =
    account !== undefined
      ? ACCOUNT_ID.test(account)
        ? jar.entries.find((e) => e.user.id === account)?.user
        : undefined
      : jar.listed
        ? undefined
        : jar.byDefault?.user;
  if (!user) return see(jar.entries.length ? `${back}&changed=1` : back);
  const checked = await checkAuthorize(params, origin);
  if ("fatal" in checked) return see(back);
  if ("redirect" in checked) return see(checked.redirect);
  const { client, redirectUri, state, challenge } = checked.ok;
  if (decision !== "allow") return see(redirectWith(redirectUri, { error: "access_denied", state }, origin));
  const code = await createCode({ clientId: client.id, userId: user.id, redirectUri, challenge });
  return see(redirectWith(redirectUri, { code, state }, origin));
}
