import { appUrl } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { unsubscribe } from "@/lib/server/contacts.ts";

export const dynamic = "force-dynamic";

const HOUR = 3_600_000;

/**
 * Someone stops an app's news with the link from its emails, without signing in: the Unsubscribe
 * button on /u/<token>, or a mail app's one-click unsubscribe (RFC 8058), which posts
 * "List-Unsubscribe=One-Click". Only a POST changes anything, so a link scanner opening the page
 * never unsubscribes anyone. The button goes back to the page, which shows what's true now.
 *
 * A link that works always unsubscribes, whoever sends it: a mail provider posts everyone's
 * one-click unsubscribes from a few servers of its own. Doing it again changes nothing, and nobody
 * can guess a link, so only links that don't work count against an address, 30 an hour.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/u/[token]">) {
  const { token } = await ctx.params;
  const body = Number(request.headers.get("content-length") ?? 0) > 1024 ? "" : (await request.text().catch(() => "")).slice(0, 1024);
  const oneClick = /List-Unsubscribe=One-Click/.test(body);
  const page = `${appUrl(request)}/u/${encodeURIComponent(token)}`;
  if (await unsubscribe(token)) return oneClick ? Response.json({ ok: true }) : Response.redirect(page, 303);
  const limited = await overLimit(`unsub-ip:${clientIp(request)}`, 30, HOUR);
  // The page says the link doesn't work.
  if (!oneClick) return Response.redirect(page, 303);
  const t = await translatorFor(request);
  return limited
    ? Response.json({ error: t("Too many tries. Please wait a few minutes.") }, { status: 429 })
    : Response.json({ error: t("Not found") }, { status: 404 });
}
