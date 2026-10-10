import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { TeamError, inviteMember, removeFromTeam } from "@/lib/server/teams.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** The reply when a team change fails: why it can't, else `message`, translated where it's written. */
function failed(err: unknown, what: string, message: string): Response {
  if (err instanceof TeamError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
  console.error(`[flash] team: couldn't ${what}`, err);
  return Response.json({ error: message }, { status: 502 });
}

/** The Business plan's owner invites someone by email. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { email } = (await request.json().catch(() => ({}))) as { email?: string };
  if (await overLimit(`team-invite:${user.id}`, 20, 3600_000)) {
    return Response.json({ error: t("Too many invitations. Try again in an hour.") }, { status: 429 });
  }
  try {
    const devLink = await inviteMember(user, String(email ?? ""), appUrl(request), t);
    return Response.json({ ok: true, devLink });
  } catch (err) {
    return failed(err, "send the invitation", t("Couldn't send the invitation. Please try again."));
  }
}

/** The owner removes a member or cancels an invitation; a member can remove themselves. */
export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown; inviteId?: unknown };
  try {
    await removeFromTeam(
      user.id,
      {
        userId: typeof body.userId === "string" ? body.userId : undefined,
        inviteId: typeof body.inviteId === "string" ? body.inviteId : undefined,
      },
      t,
    );
    return Response.json({ ok: true });
  } catch (err) {
    return failed(err, "update the team", t("Couldn't update the team. Please try again."));
  }
}
