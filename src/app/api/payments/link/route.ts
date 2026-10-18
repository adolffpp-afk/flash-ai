import { ACCOUNT_ID, appUrl, getUser } from "@/lib/server/auth.ts";
import { sellerOnboardingLink } from "@/lib/server/shop.ts";

export const dynamic = "force-dynamic";

/**
 * Stripe sends sellers here when their sign-up link expired: open a fresh one, for the account it
 * was made for (?as=, see shop.ts). When that account isn't signed in here, Flash opens and asks
 * to sign in to it: never a sign-up for another account.
 */
export async function GET(request: Request) {
  const origin = appUrl(request);
  const as = new URL(request.url).searchParams.get("as");
  const back = `${origin}/?apps=1${as && ACCOUNT_ID.test(as) ? `&as=${encodeURIComponent(as)}` : ""}`;
  const headers = { "Cache-Control": "no-store" };
  const user = await getUser(request);
  if (!user) return new Response(null, { status: 303, headers: { ...headers, Location: back } });
  const result = await sellerOnboardingLink(user, null, origin);
  return new Response(null, { status: 303, headers: { ...headers, Location: "url" in result ? result.url : back } });
}
