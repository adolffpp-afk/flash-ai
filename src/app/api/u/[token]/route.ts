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
 */
export async function POST(request: Request, ctx: RouteContext<"/api/u/[token]">) {
  const { token } = await ctx.params;
  const body = Number(request.headers.get("content-length") ?? 0) > 1024 ? "" : (await request.text().catch(() => "")).slice(0, 1024);
  const oneClick = /List-Unsubscribe=One-Click/.test(body);
  const page = `${appUrl(request)}/u/${encodeURIComponent(token)}`;
  if (await overLimit(`unsub-ip:${clientIp(request)}`, 30, HOUR)) {
    if (!oneClick) return Response.redirect(`${page}?wait=1`, 303);
    const t = await translatorFor(request);
    return Response.json({ error: t("Too many tries. Please wait a few minutes.") }, { status: 429 });
  }
  const done = await unsubscribe(token);
  if (oneClick && !done) return Response.json({ error: (await translatorFor(request))("Not found") }, { status: 404 });
  if (oneClick) return Response.json({ ok: true });
  return Response.redirect(page, 303);
}
