import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one } from "@/lib/server/db.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { deleteProduct, listOrders, listProducts, saveProduct } from "@/lib/server/shop.ts";
import { itemsInHtml } from "@/lib/shop.ts";

export const dynamic = "force-dynamic";

/** What the site sells, the items its code names that have no price yet, and its orders. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/products">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: "Not found" }, { status: 404 });
  const products = await listProducts(slug);
  const site = await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]);
  const priced = new Set(products.map((p) => p.name.toLowerCase()));
  const unpriced = itemsInHtml(site?.html ?? "").filter((name) => !priced.has(name.toLowerCase()));
  return Response.json({ products, unpriced, orders: await listOrders(user.id, slug) });
}

export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/products">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: "Not found" }, { status: 404 });
  const result = await saveProduct(user, slug, (await request.json().catch(() => ({}))) as Record<string, unknown>);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ product: result });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/products">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: "Not found" }, { status: 404 });
  await deleteProduct(slug, new URL(request.url).searchParams.get("id") ?? "");
  return Response.json({ ok: true });
}
