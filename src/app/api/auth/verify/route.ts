import { markVerified, redeemToken } from "@/lib/server/account.ts";
import { ensureMonthlyCredits } from "@/lib/server/credits.ts";

/** The link in the verification email. Confirms the address and adds the free credits. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = await redeemToken(url.searchParams.get("token") ?? "", "verify");
  if (!userId) return Response.redirect(new URL("/?verified=invalid", url.origin), 303);
  await markVerified(userId);
  await ensureMonthlyCredits(userId);
  return Response.redirect(new URL("/?verified=1", url.origin), 303);
}
