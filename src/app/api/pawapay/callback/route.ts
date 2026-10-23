import { settleMobileMoney } from "@/lib/server/pawapay.ts";

/*
 * pawaPay calls this when a deposit, payout or refund ends (set as the callback URL for all four
 * in pawaPay's dashboard). Its body is never trusted: a deposit's id only makes Flash ask pawaPay's
 * API what happened (see settleMobileMoney). Payouts and refunds aren't used yet. pawaPay retries
 * anything but 200, so a deposit Flash couldn't check yet answers 500 to be sent again.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { depositId?: unknown };
  if (typeof body.depositId !== "string") return new Response("ok");
  try {
    await settleMobileMoney(body.depositId);
    return new Response("ok");
  } catch (err) {
    console.error("[flash] pawaPay callback failed", err);
    return new Response("try again", { status: 500 });
  }
}
