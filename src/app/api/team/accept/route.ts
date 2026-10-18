import { getUser, jarSessions, unauthorized } from "@/lib/server/auth.ts";
import { emailKey } from "@/lib/server/account.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { TeamError, acceptInvite, inviteEmailKey } from "@/lib/server/teams.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** Joins a team from an emailed invitation link. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (await overLimit(`team-accept:${clientIp(request)}`, 20, 3600_000)) {
    return Response.json({ error: t("Too many attempts. Try again in an hour.") }, { status: 429 });
  }
  const { token: raw } = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof raw === "string" ? raw : "";
  // An invitation for another account signed in here: that account joins, after a switch to it.
  const key = await inviteEmailKey(token);
  if (key && key !== emailKey(user.email)) {
    const other = (await jarSessions(request)).entries.find((e) => emailKey(e.user.email) === key);
    if (other) {
      return Response.json(
        {
          error: t("This invitation is for {email}. Switch to that account to join.", { email: other.user.email }),
          code: "other_account",
          forAccount: { id: other.user.id, email: other.user.email },
        },
        { status: 409 },
      );
    }
  }
  try {
    await acceptInvite(user, token, t);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
    console.error("[flash] joining a team failed", err);
    return Response.json({ error: t("Couldn't join the team. Please try again.") }, { status: 502 });
  }
}
