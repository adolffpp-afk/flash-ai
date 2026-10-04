import { appUrl } from "@/lib/server/auth.ts";
import { finishCheckout } from "@/lib/server/shop.ts";
import { withPaidNote } from "@/lib/shop.ts";

export const dynamic = "force-dynamic";

/** Stripe sends buyers here after paying; the order is saved and they go back to the site. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/shop/done">) {
  const { slug } = await ctx.params;
  const params = new URL(request.url).searchParams;
  const { page, paid } = await finishCheckout(slug, params.get("session") ?? "", params.get("back"), appUrl(request));
  return Response.redirect(paid ? withPaidNote(page) : page, 303);
}
