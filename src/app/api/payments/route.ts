import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { canSell, sellerOnboardingLink, sellerStatus, sellingAvailable } from "@/lib/server/shop.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

export const dynamic = "force-dynamic";

/** Whether the user can sell from their sites, and where their Stripe account stands. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const available = sellingAvailable();
  return Response.json({
    available,
    allowed: available && (await canSell(user)),
    seller: available ? await sellerStatus(user.id) : { connected: false, ready: false, currency: "", country: "" },
  });
}

/** Opens Stripe's sign-up for the user's seller account. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { country } = (await request.json().catch(() => ({}))) as { country?: string };
  const result = await sellerOnboardingLink(user, country, appUrl(request), t);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
