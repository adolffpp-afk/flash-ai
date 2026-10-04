import { appUrl } from "@/lib/server/auth.ts";
import { clientIp } from "@/lib/server/limits.ts";
import { publicItems, startCheckout } from "@/lib/server/shop.ts";

export const dynamic = "force-dynamic";

// Published sites run on an opaque origin, so the shop answers any origin and never uses cookies.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** The items the site sells with their prices (window.flashDB fills data-flash-price with them). */
export async function GET(_request: Request, ctx: RouteContext<"/api/sites/[slug]/shop">) {
  const { slug } = await ctx.params;
  return Response.json({ items: await publicItems(slug) }, { headers: CORS });
}

/** A visitor buys an item (window.flashDB.buy): answers with the Stripe Checkout address. */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/shop">) {
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await startCheckout(slug, body, clientIp(request), appUrl(request));
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status, headers: CORS });
  return Response.json(result, { headers: CORS });
}
