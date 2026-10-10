import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { requestStop } from "@/lib/server/stops.ts";
import { MESSAGE_ID } from "@/lib/server/turns.ts";

/**
 * The Stop button: closing the page doesn't stop a reply any more, so Stop is sent here, by the
 * reply's id. A writing engine stops within a second or two; a picture, video or sound already
 * being made is finished and delivered (see the chat route).
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { replyId } = (await request.json().catch(() => ({}))) as { replyId?: unknown };
  if (typeof replyId !== "string" || !MESSAGE_ID.test(replyId)) {
    const t = await translatorFor(request, user.language);
    return Response.json({ error: t("Not found") }, { status: 404 });
  }
  await requestStop(user.id, replyId);
  return Response.json({ ok: true });
}
