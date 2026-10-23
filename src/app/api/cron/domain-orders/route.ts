import { timingSafeEqual } from "node:crypto";
import { finishOpenOrders } from "@/lib/server/domain-orders.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Whether the request carries CRON_SECRET, as Vercel's scheduled jobs send it (Authorization: Bearer …). */
function fromCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The domain order finisher, every 15 minutes (vercel.json): orders waiting on Stripe, Name.com or their setup. */
export async function GET(request: Request) {
  if (!fromCron(request)) return new Response("Unauthorized", { status: 401 });
  return Response.json({ checked: await finishOpenOrders() });
}
