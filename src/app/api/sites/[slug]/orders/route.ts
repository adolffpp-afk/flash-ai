import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { one } from "@/lib/server/db.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { listOrders, markOrder } from "@/lib/server/shop.ts";
import { csvName, toCsv } from "@/lib/csv.ts";

export const dynamic = "force-dynamic";

/** The site's orders as a spreadsheet file (CSV), for the owner. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/orders">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const site = await one<{ title: string }>("SELECT title FROM sites WHERE slug = ?", [slug]);
  const orders = await listOrders(user.id, slug);
  const csv = toCsv([
    [t("Date"), t("Item"), t("Quantity"), t("Total"), t("Name"), t("Email"), t("Address"), t("Done"), t("Stripe checkout")],
    ...orders.map((o) => [
      new Date(o.createdAt).toISOString().slice(0, 16).replace("T", " "),
      o.item,
      o.quantity,
      o.total,
      o.name,
      o.email,
      o.address,
      o.done ? t("Yes") : t("No"),
      o.id,
    ]),
  ]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvName(site?.title ?? "", "orders")}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Marks an order as handled (sent or picked up), or back to waiting. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/orders">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; done?: unknown };
  if (typeof body.id !== "string" || !(await markOrder(slug, body.id, body.done === true))) {
    return Response.json({ error: t("Order not found.") }, { status: 404 });
  }
  return Response.json({ ok: true });
}
