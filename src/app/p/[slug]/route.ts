import { after } from "next/server";
import { getUser } from "@/lib/server/auth.ts";
import { serveSite } from "@/lib/server/serve-site.ts";
import { recordOwnerVisit, recordVisit } from "@/lib/server/visits.ts";
import { OWNER_CODE_PARAM } from "@/lib/flashdb-shim.ts";

export async function GET(request: Request, ctx: RouteContext<"/p/[slug]">) {
  const { slug } = await ctx.params;
  const page = await serveSite(slug, `${new URL(request.url).origin}/p/${slug}`, request);
  // A load with an Open as owner code is never a visit, whether the code worked or not. When it
  // worked, the owner's steps that day aren't counted either.
  const asOwner = new URL(request.url).searchParams.has(OWNER_CODE_PARAM);
  if (page.ok && page.ownerView) after(() => recordOwnerVisit(slug, request));
  if (page.ok && !asOwner) after(async () => recordVisit(slug, request, (await getUser(request).catch(() => null))?.id));
  return page;
}
