import { getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { mobileMoneyFor, mobileMoneyPrices } from "@/lib/server/pawapay.ts";
import { mobileMoneyCountry } from "@/lib/mobile-money.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

export const dynamic = "force-dynamic";

/** What everything costs with mobile money in one country, in its money, by product id. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!mobileMoneyFor(isAdmin(user))) return Response.json({ error: t("Payments are coming soon.") }, { status: 503 });
  const country = mobileMoneyCountry(new URL(request.url).searchParams.get("country"));
  if (!country) return Response.json({ error: t("Mobile money isn't available in that country yet.") }, { status: 400 });
  const prices = await mobileMoneyPrices(country);
  if (!prices) return Response.json({ error: t("Couldn't open checkout. Please try again.") }, { status: 502 });
  return Response.json({ country: country.code, currency: country.currency, prices });
}
