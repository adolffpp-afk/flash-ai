import { appUrl, getUser } from "@/lib/server/auth.ts";
import { sellerOnboardingLink } from "@/lib/server/shop.ts";

export const dynamic = "force-dynamic";

/** Stripe sends sellers here when their sign-up link expired: open a fresh one. */
export async function GET(request: Request) {
  const origin = appUrl(request);
  const user = await getUser(request);
  if (!user) return Response.redirect(`${origin}/?apps=1`, 303);
  const result = await sellerOnboardingLink(user, null, origin);
  return Response.redirect("url" in result ? result.url : `${origin}/?apps=1`, 303);
}
