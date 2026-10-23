import { appUrl, getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { mobileMoneyFor, startMobileMoney } from "@/lib/server/pawapay.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** Starts a mobile money purchase and answers with pawaPay's Payment Page to send the buyer to. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const admin = isAdmin(user);
  const mode = mobileMoneyFor(admin);
  if (!mode) return Response.json({ error: t("Payments are coming soon.") }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { product?: unknown; country?: unknown };
  const result = await startMobileMoney(user, mode, body.product, body.country, appUrl(request));
  if ("url" in result) return Response.json({ url: result.url });
  if (result.error === "product") return Response.json({ error: t("Unknown credit pack.") }, { status: 400 });
  if (result.error === "country") return Response.json({ error: t("Mobile money isn't available in that country yet.") }, { status: 400 });
  // Admins also see what pawaPay said, so a setting to fix there can be found without the logs.
  const why = admin && result.message ? ` (pawaPay: ${result.message})` : "";
  return Response.json({ error: t("Couldn't open checkout. Please try again.") + why }, { status: 502 });
}
