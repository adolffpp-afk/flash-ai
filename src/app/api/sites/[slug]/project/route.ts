import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { projectForSite } from "@/lib/server/sites.ts";

export const dynamic = "force-dynamic";

/** Which of the owner's chats built this site, so Edit in My websites can open it. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/project">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  const project = await projectForSite(user.id, slug);
  if (!project) return Response.json({ error: t("Couldn't find the chat that built this site.") }, { status: 404 });
  return Response.json({ project });
}
