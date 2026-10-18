import { ACCOUNT_ID, defaultCookies, fromOwnPage, jarSessions } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/**
 * Switch account: makes one of the accounts this browser is signed in to the default, the one new
 * tabs and links open as (see the jar in auth.ts). It only chooses among sessions the browser
 * already holds, so it never makes, renews or ends a session, and needs no limit. Only Flash's own
 * pages may ask (see fromOwnPage), so another site can't change which account a browser uses.
 */
export async function POST(request: Request) {
  const jar = await jarSessions(request);
  const t = await translatorFor(request, jar.byDefault?.user.language);
  if (!fromOwnPage(request)) return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { account?: unknown };
  const id = typeof body.account === "string" && ACCOUNT_ID.test(body.account) ? body.account : "";
  const entry = jar.entries.find((e) => e.user.id === id);
  if (!entry) {
    return Response.json({ error: t("That account isn't signed in on this browser anymore."), code: "not_signed_in" }, { status: 404 });
  }
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of defaultCookies(request, jar, entry)) headers.append("Set-Cookie", cookie);
  return Response.json({ ok: true, account: entry.user.id }, { headers });
}
