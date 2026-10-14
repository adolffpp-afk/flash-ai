import { getUser } from "@/lib/server/auth.ts";
import { confirmEmail } from "@/lib/server/account.ts";
import { ensureMonthlyCredits } from "@/lib/server/credits.ts";

/** The link in the verification email. Confirms the address and adds the free credits (see confirmEmail). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const user = await getUser(request);
  const result = await confirmEmail(url.searchParams.get("token") ?? "", user?.id ?? null);
  if (result === "confirmed") await ensureMonthlyCredits(user!.id);
  const verified = result === "confirmed" ? "1" : result === "sign_in" ? "signin" : "invalid";
  return Response.redirect(new URL(`/?verified=${verified}`, url.origin), 303);
}
