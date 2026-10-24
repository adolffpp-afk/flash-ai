import { appUrl } from "@/lib/server/auth.ts";
import { stopEmails } from "@/lib/server/automation-alerts.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";

export const dynamic = "force-dynamic";

const HOUR = 3_600_000;

/**
 * Someone stops an automation's result emails with the link from one, without signing in: the button
 * on /stop-email/<token>, or a mail app's one-click unsubscribe (RFC 8058), which posts
 * "List-Unsubscribe=One-Click". Only a POST changes anything, so a link scanner opening the page (or
 * this address) never stops them. The button goes back to the page, which shows what's true now.
 *
 * A link that works always stops them, whoever sends it (a mail provider posts one-click unsubscribes
 * from its own servers), and doing it again changes nothing; nobody can guess a link, so only links
 * that don't work count against an address, 30 an hour.
 */
/**
 * A mail app without one-click unsubscribes opens the List-Unsubscribe address in a browser: the page,
 * which asks first (a link scanner opening it stops nothing).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/stop-email/[token]">) {
  const { token } = await ctx.params;
  return Response.redirect(`${appUrl(request)}/stop-email/${encodeURIComponent(token)}`, 303);
}

export async function POST(request: Request, ctx: RouteContext<"/api/stop-email/[token]">) {
  const { token } = await ctx.params;
  const body = Number(request.headers.get("content-length") ?? 0) > 1024 ? "" : (await request.text().catch(() => "")).slice(0, 1024);
  const oneClick = /List-Unsubscribe=One-Click/.test(body);
  const page = `${appUrl(request)}/stop-email/${encodeURIComponent(token)}`;
  if (await stopEmails(token)) return oneClick ? Response.json({ ok: true }) : Response.redirect(page, 303);
  const limited = await overLimit(`stop-email-ip:${clientIp(request)}`, 30, HOUR);
  // The page says the link doesn't work.
  if (!oneClick) return Response.redirect(page, 303);
  const t = await translatorFor(request);
  return limited
    ? Response.json({ error: t("Too many tries. Please wait a few minutes.") }, { status: 429 })
    : Response.json({ error: t("Not found") }, { status: 404 });
}
