import { after } from "next/server";
import { getUser } from "@/lib/server/auth.ts";
import { serveSite } from "@/lib/server/serve-site.ts";
import { recordVisit } from "@/lib/server/visits.ts";
import { SITE_URL } from "@/app/site.ts";

export async function GET(request: Request, ctx: RouteContext<"/p/[slug]">) {
  const { slug } = await ctx.params;
  // Its main address is on Flash's main domain, so copies on other addresses (*.vercel.app) point there.
  const canonical = `${(process.env.FLASH_APP_URL || SITE_URL).replace(/\/$/, "")}/p/${slug}`;
  const page = await serveSite(slug, `${new URL(request.url).origin}/p/${slug}`, request, canonical);
  if (page.ok) after(async () => recordVisit(slug, request, (await getUser(request).catch(() => null))?.id));
  return page;
}
