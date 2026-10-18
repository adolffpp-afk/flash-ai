import { after } from "next/server";
import { siteDomains, siteForDomain } from "@/lib/server/domains.ts";
import { serveSite } from "@/lib/server/serve-site.ts";
import { recordOwnerVisit, recordVisit } from "@/lib/server/visits.ts";
import { OWNER_CODE_PARAM } from "@/lib/flashdb-shim.ts";
import { mainDomain } from "@/lib/seo-rules.ts";

/** A published site shown on its own domain (src/proxy.ts sends those visits here). */
export async function GET(request: Request, ctx: RouteContext<"/d/[host]">) {
  const { host } = await ctx.params;
  const domain = decodeURIComponent(host).toLowerCase();
  const slug = await siteForDomain(domain);
  // Each domain is the page's main address on it, never another domain, except www. when the bare
  // domain shows the app too: both name the bare one. The share card keeps the address it was opened at.
  const main = slug ? mainDomain(domain, (await siteDomains(slug)).live) : domain;
  const page = await serveSite(slug, `https://${domain}/`, request, `https://${main}/`);
  // Flash's sign-in cookie isn't sent to other domains, so only the owner opening it with Open as
  // owner is left out here: a load with the code is never a visit, and with a code that worked, the
  // owner's steps that day aren't counted either.
  const asOwner = new URL(request.url).searchParams.has(OWNER_CODE_PARAM);
  if (slug && page.ok && page.ownerView) after(() => recordOwnerVisit(slug, request));
  if (slug && page.ok && !asOwner) after(() => recordVisit(slug, request));
  return page;
}
