import { after } from "next/server";
import { getUser } from "@/lib/server/auth.ts";
import { serveSite } from "@/lib/server/serve-site.ts";
import { recordVisit } from "@/lib/server/visits.ts";

export async function GET(request: Request, ctx: RouteContext<"/p/[slug]">) {
  const { slug } = await ctx.params;
  const page = await serveSite(slug, `${new URL(request.url).origin}/p/${slug}`, request);
  if (page.ok) after(async () => recordVisit(slug, request, (await getUser(request).catch(() => null))?.id));
  return page;
}
