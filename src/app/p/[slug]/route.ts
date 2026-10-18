import { after } from "next/server";
import { jarSessions } from "@/lib/server/auth.ts";
import { serveSite } from "@/lib/server/serve-site.ts";
import { recordOwnerVisit, recordVisit } from "@/lib/server/visits.ts";
import { OWNER_CODE_PARAM } from "@/lib/flashdb-shim.ts";
import { SITE_URL } from "@/app/site.ts";

export async function GET(request: Request, ctx: RouteContext<"/p/[slug]">) {
  const { slug } = await ctx.params;
  // Its main address is on Flash's main domain, so copies on other addresses (*.vercel.app) point there.
  const canonical = `${(process.env.FLASH_APP_URL || SITE_URL).replace(/\/$/, "")}/p/${slug}`;
  const page = await serveSite(slug, `${new URL(request.url).origin}/p/${slug}`, request, canonical);
  // A load with an Open as owner code is never a visit, whether the code worked or not. When it
  // worked, the owner's steps that day aren't counted either.
  const asOwner = new URL(request.url).searchParams.has(OWNER_CODE_PARAM);
  if (page.ok && page.ownerView) after(() => recordOwnerVisit(slug, request));
  // Nor is a load by the app's owner when that is any of the accounts signed in to this browser.
  if (page.ok && !asOwner) after(async () => recordVisit(slug, request, (await jarSessions(request).catch(() => null))?.entries.map((e) => e.user.id)));
  return page;
}
