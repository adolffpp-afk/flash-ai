import { after } from "next/server";
import { jarSessions } from "@/lib/server/auth.ts";
import { serveSite } from "@/lib/server/serve-site.ts";
import { recordVisit } from "@/lib/server/visits.ts";

export async function GET(request: Request, ctx: RouteContext<"/p/[slug]">) {
  const { slug } = await ctx.params;
  const page = await serveSite(slug, `${new URL(request.url).origin}/p/${slug}`, request);
  // Not counted when the app's owner is any of the accounts signed in to this browser.
  if (page.ok) after(async () => recordVisit(slug, request, (await jarSessions(request).catch(() => null))?.entries.map((e) => e.user.id)));
  return page;
}
