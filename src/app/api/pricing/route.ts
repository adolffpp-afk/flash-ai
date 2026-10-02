import { pricingInfo } from "@/lib/server/pricing.ts";

export const dynamic = "force-dynamic";

/** Public: what Flash costs, for the landing page. */
export function GET() {
  return Response.json(pricingInfo());
}
