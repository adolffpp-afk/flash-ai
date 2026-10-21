import { getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { mobileMoneyReport, settleMobileMoney } from "@/lib/server/pawapay.ts";

export const dynamic = "force-dynamic";

/** The owner dashboard's Mobile money tab (see mobileMoneyReport). before (a created_at) gets the next page. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  const before = Math.max(0, Math.floor(Number(new URL(request.url).searchParams.get("before")) || 0));
  return Response.json(await mobileMoneyReport(before));
}

/** Asks pawaPay again about one order still pending, and gives its credits if it's now paid. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  const { depositId } = (await request.json().catch(() => ({}))) as { depositId?: unknown };
  if (typeof depositId !== "string") return Response.json({ error: "No order." }, { status: 400 });
  try {
    const order = await settleMobileMoney(depositId);
    return order ? Response.json({ status: order.status }) : Response.json({ error: "No such order." }, { status: 404 });
  } catch (err) {
    console.error("[flash] pawaPay re-check failed", err);
    return Response.json({ error: "pawaPay didn't answer. Try again in a minute." }, { status: 502 });
  }
}
