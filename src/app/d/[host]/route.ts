import { siteForDomain } from "@/lib/server/domains.ts";
import { serveSite } from "@/lib/server/serve-site.ts";

/** A published site shown on its own domain (src/proxy.ts sends those visits here). */
export async function GET(_request: Request, ctx: RouteContext<"/d/[host]">) {
  const { host } = await ctx.params;
  return serveSite(await siteForDomain(decodeURIComponent(host).toLowerCase()));
}
