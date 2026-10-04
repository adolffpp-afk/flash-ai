import { after } from "next/server";
import { siteForDomain } from "@/lib/server/domains.ts";
import { serveSite } from "@/lib/server/serve-site.ts";
import { recordVisit } from "@/lib/server/visits.ts";

/** A published site shown on its own domain (src/proxy.ts sends those visits here). */
export async function GET(request: Request, ctx: RouteContext<"/d/[host]">) {
  const { host } = await ctx.params;
  const domain = decodeURIComponent(host).toLowerCase();
  const slug = await siteForDomain(domain);
  const page = await serveSite(slug, `https://${domain}/`);
  // Flash's sign-in cookie isn't sent to other domains, so there is no owner to leave out here.
  if (slug && page.ok) after(() => recordVisit(slug, request));
  return page;
}
