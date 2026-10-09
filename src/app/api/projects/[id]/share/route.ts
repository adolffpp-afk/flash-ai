import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { createShare, deleteShares } from "@/lib/server/shares.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { SITE_URL } from "@/app/site.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** Makes a read-only link to the project as it is now. */
export async function POST(request: Request, ctx: RouteContext<"/api/projects/[id]/share">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (await overLimit(`share:${user.id}`, 30, 3600_000)) {
    return Response.json({ error: t("You've made a lot of links. Try again in an hour.") }, { status: 429 });
  }
  const { id } = await ctx.params;
  const share = await createShare(user.id, id);
  if (!share) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json({ url: `${SITE_URL}/s/${share}` });
}

/** Stops sharing: every link to this project stops working. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/projects/[id]/share">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  return Response.json({ removed: await deleteShares(user.id, id) });
}
