import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { settleMobileMoney } from "@/lib/server/pawapay.ts";

export const dynamic = "force-dynamic";

/**
 * Where the buyer's mobile money payment is, for the page pawaPay sends them back to: pending,
 * completed (credits given) or failed. Without a deposit id, their latest order of the last hour.
 */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const asked = new URL(request.url).searchParams.get("depositId");
  const row = await one<{ deposit_id: string }>(
    asked
      ? "SELECT deposit_id FROM mobile_money_orders WHERE deposit_id = ? AND user_id = ?"
      : "SELECT deposit_id FROM mobile_money_orders WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1",
    asked ? [asked, user.id] : [user.id, Date.now() - 60 * 60 * 1000],
  );
  if (!row) return Response.json({ status: "none" });
  const order = await settleMobileMoney(row.deposit_id).catch((err) => {
    console.error("[flash] pawaPay status check failed", err);
    return null;
  });
  return Response.json({ status: order?.status ?? "pending" });
}
