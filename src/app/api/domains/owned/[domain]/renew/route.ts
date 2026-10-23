import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { startRenewal } from "@/lib/server/domain-orders.ts";

export const dynamic = "force-dynamic";

/** Renews one of the user's domains for a year: answers with Stripe Checkout's page to hold the card, or (in Name.com's sandbox) the order to follow. */
export async function POST(request: Request, ctx: RouteContext<"/api/domains/owned/[domain]/renew">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (await overLimit(`domain-checkout:${user.id}`, 5, 24 * 60 * 60_000)) {
    return Response.json({ error: t("Flash has sold all the domains it can today. Please try again tomorrow.") }, { status: 429 });
  }
  const { domain } = await ctx.params;
  const result = await startRenewal(user, decodeURIComponent(domain).toLowerCase(), appUrl(request), t);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
