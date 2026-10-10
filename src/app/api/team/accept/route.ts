import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { TeamError, acceptInvite } from "@/lib/server/teams.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** Joins a team from an emailed invitation link. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (await overLimit(`team-accept:${clientIp(request)}`, 20, 3600_000)) {
    return Response.json({ error: t("Too many attempts. Try again in an hour.") }, { status: 429 });
  }
  const { token } = (await request.json().catch(() => ({}))) as { token?: unknown };
  try {
    await acceptInvite(user, typeof token === "string" ? token : "", t);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
    console.error("[flash] joining a team failed", err);
    return Response.json({ error: t("Couldn't join the team. Please try again.") }, { status: 502 });
  }
}
