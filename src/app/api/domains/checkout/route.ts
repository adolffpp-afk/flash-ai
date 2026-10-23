import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { domainSalesFor, startDomainOrder } from "@/lib/server/domain-orders.ts";

export const dynamic = "force-dynamic";

/** Starts buying a domain: answers with Stripe Checkout's page to hold the card, or (in Name.com's sandbox) the order to follow. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const mode = domainSalesFor(user);
  if (!mode) return Response.json({ error: t("Buying a domain in Flash is coming soon.") }, { status: 403 });
  if (await overLimit(`domain-checkout:${user.id}`, 5, 24 * 60 * 60_000)) {
    return Response.json({ error: t("Flash has sold all the domains it can today. Please try again tomorrow.") }, { status: 429 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await startDomainOrder(user, mode, body, appUrl(request), t);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
