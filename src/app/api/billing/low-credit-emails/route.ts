import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { emailEnabled } from "@/lib/server/email.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { alertSettings, saveAlertSettings } from "@/lib/server/low-balance.ts";

/**
 * The signed-in person's low-credit emails (see low-balance.ts): on or off, and below what balance.
 * emails is whether Flash can send email at all; Credits shows the setting only when it can.
 */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ ...(await alertSettings(user.id)), emails: emailEnabled() });
}

/** Saves their choice: { enabled, below }, below one of the levels GET lists. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; below?: unknown };
  const saved = await saveAlertSettings(user.id, { enabled: body.enabled === true, below: Number(body.below) });
  if (!saved) {
    const t = await translatorFor(request, user.language);
    return Response.json({ error: t("Pick a level from the list.") }, { status: 400 });
  }
  return Response.json({ ...saved, emails: emailEnabled() });
}
