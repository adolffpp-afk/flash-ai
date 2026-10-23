import { finishOpenOrders, fromCron } from "@/lib/server/domain-orders.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The domain order finisher, every 15 minutes (vercel.json): orders waiting on Stripe, Name.com or their setup. */
export async function GET(request: Request) {
  if (!fromCron(request)) return new Response("Unauthorized", { status: 401 });
  return Response.json({ checked: await finishOpenOrders() });
}
