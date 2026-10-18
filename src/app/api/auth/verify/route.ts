import { jarSessions } from "@/lib/server/auth.ts";
import { confirmEmailFor } from "@/lib/server/account.ts";
import { ensureMonthlyCredits } from "@/lib/server/credits.ts";

/**
 * The link in the verification email. Confirms the address and adds the free credits (see
 * confirmEmail), when its account is one of those signed in here, and opens Flash as that account.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ids = (await jarSessions(request)).entries.map((e) => e.user.id);
  const { status, userId } = await confirmEmailFor(url.searchParams.get("token") ?? "", ids);
  if (status === "confirmed") {
    await ensureMonthlyCredits(userId!);
    return Response.redirect(new URL(`/?verified=1&as=${encodeURIComponent(userId!)}`, url.origin), 303);
  }
  return Response.redirect(new URL(`/?verified=${status === "sign_in" ? "signin" : "invalid"}`, url.origin), 303);
}
