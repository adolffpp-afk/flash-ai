import { serveSite } from "@/lib/server/serve-site.ts";

export async function GET(_request: Request, ctx: RouteContext<"/p/[slug]">) {
  const { slug } = await ctx.params;
  return serveSite(slug);
}
