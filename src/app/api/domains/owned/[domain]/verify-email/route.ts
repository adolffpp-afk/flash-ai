import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { resendDomainEmail } from "@/lib/server/domain-checks.ts";

export const dynamic = "force-dynamic";

/** Asks Name.com to send the registrant's confirmation email again (3 a day per domain). */
export async function POST(request: Request, ctx: RouteContext<"/api/domains/owned/[domain]/verify-email">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const domain = decodeURIComponent((await ctx.params).domain).toLowerCase();
  if (await overLimit(`domain-verify:${domain}`, 3, 24 * 60 * 60_000)) {
    return Response.json({ error: t("The email was sent again already. Please try tomorrow.") }, { status: 429 });
  }
  const result = await resendDomainEmail(user.id, domain);
  if (result === "missing") return Response.json({ error: t("Not found") }, { status: 404 });
  if (result === "wait") return Response.json({ error: t("The email was sent again already. Please try tomorrow.") }, { status: 429 });
  if (result === "failed") return Response.json({ error: t("Couldn't send the email again. Please try later.") }, { status: 502 });
  return Response.json({ result });
}
