import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { MAX_PICK, googleReady } from "@/lib/server/google.ts";
import { ConnectError, addPickedFiles, forgetPickedFile, problemText } from "@/lib/server/connections.ts";
import { approvalAllowed } from "@/lib/server/pending-actions.ts";

/*
 * The Google Drive files a user picked for Flash (see google.ts). POST records the ids Google's Picker
 * gave the page, { connectionId, ids }: nothing the page says is believed, each id is looked up at
 * Google with the user's own token, and the name and type kept are Google's. DELETE forgets one,
 * { connectionId, fileId }. Both change what Flash may open, so they are taken only from Flash's own
 * page with its exact Origin (S-3). Neither costs anything or calls a model.
 */

type Body = { connectionId?: unknown; ids?: unknown; fileId?: unknown };

const statusOf = (code: string) => (code === "limit" ? 429 : code === "unverified" ? 403 : code === "gone" ? 404 : code === "reconnect" || code === "too_many_files" ? 409 : 400);

async function handle(request: Request, act: (userId: string, body: Body) => Promise<Response>) {
  const headers = { "cache-control": "no-store" };
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!approvalAllowed(request, [new URL(appUrl(request)).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403, headers });
  }
  if (!googleReady()) return Response.json({ error: t("Not found") }, { status: 404, headers });
  const body = (await request.json().catch(() => ({}))) as Body;
  if (typeof body.connectionId !== "string" || !body.connectionId || body.connectionId.length > 40) return Response.json({ error: t("Not found") }, { status: 404, headers });
  try {
    return await act(user.id, body);
  } catch (err) {
    if (err instanceof ConnectError) {
      const error = err.code === "bad_input" ? t("Pick at most {count} files at a time.", { count: MAX_PICK }) : problemText(err.code, t);
      return Response.json({ error, code: err.code }, { status: statusOf(err.code), headers });
    }
    console.error("[flash] Google Drive files failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500, headers });
  }
}

export function POST(request: Request) {
  return handle(request, async (userId, body) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.length <= 200) : [];
    if (!ids.length || ids.length > MAX_PICK || ids.length !== (body.ids as unknown[]).length) throw new ConnectError("bad_input", "Pick between 1 and 20 files at a time.");
    return Response.json(await addPickedFiles(userId, String(body.connectionId), ids), { headers: { "cache-control": "no-store" } });
  });
}

export function DELETE(request: Request) {
  return handle(request, async (userId, body) => {
    if (typeof body.fileId !== "string" || body.fileId.length > 200) throw new ConnectError("gone", "That file isn't picked.");
    return Response.json({ files: await forgetPickedFile(userId, String(body.connectionId), body.fileId) }, { headers: { "cache-control": "no-store" } });
  });
}
