import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { orderFor } from "@/lib/server/domain-orders.ts";

export const dynamic = "force-dynamic";
// A purchase can wait on Name.com for up to a minute.
export const maxDuration = 120;

/** How a domain order is going. Asking also takes it a step on, so a stuck one finishes while its page is open. */
export async function GET(request: Request, ctx: RouteContext<"/api/domains/orders/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { id } = await ctx.params;
  const order = await orderFor(user.id, id);
  if (!order) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json({ order });
}
