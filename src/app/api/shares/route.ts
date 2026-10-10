import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { deleteShare, listShares } from "@/lib/server/shares.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

export const dynamic = "force-dynamic";

/** The chat links the user has shared. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ shares: await listShares(user.id) });
}

/** Stops one shared link: DELETE /api/shares?id=… */
export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!(await deleteShare(user.id, id))) {
    const t = await translatorFor(request, user.language);
    return Response.json({ error: t("That link wasn't found.") }, { status: 404 });
  }
  return Response.json({ ok: true });
}
