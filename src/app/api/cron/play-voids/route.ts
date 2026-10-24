import { fromCron } from "@/lib/server/domain-orders.ts";
import { takeBackVoidedPlayPurchases } from "@/lib/server/play-voids.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Takes back the credits of Play purchases Google refunded or reversed, every hour (vercel.json). */
export async function GET(request: Request) {
  if (!fromCron(request)) return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json({ takenBack: await takeBackVoidedPlayPurchases() });
  } catch (err) {
    console.error("[flash] play voided purchases failed", err);
    return Response.json({ error: "failed" }, { status: 502 });
  }
}
