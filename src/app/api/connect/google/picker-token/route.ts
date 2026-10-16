import { appUrl, getUser } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { googleReady, pickerSettings } from "@/lib/server/google.ts";
import { mockOrigin } from "@/lib/server/safe-fetch.ts";
import { ConnectError, googlePickerToken, problemText } from "@/lib/server/connections.ts";
import { approvalAllowed } from "@/lib/server/pending-actions.ts";

/*
 * What Google's Picker needs in the user's own browser (Settings > Connectors, Add from Drive): the
 * user's own short-lived Google access token for drive.file (renewed first when it is about to
 * expire), the Picker's API key and the Cloud project's number. This is the one answer that carries
 * a token, by design: Google's Picker runs in the browser and needs it. So it is POST only (never in
 * an address or a browser's history), taken only from Flash's own page with its exact Origin (S-3),
 * only for the signed-in user's own Google Drive connection, only from a confirmed account, never
 * stored by a browser or a cache (no-store on every answer), and never logged. The API key and the
 * project number reach the page only here, never in its source. It costs nothing and calls no model.
 */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store", Pragma: "no-cache" };
  const user = await getUser(request);
  if (!user) return Response.json({ error: "Please sign in.", code: "signed_out" }, { status: 401, headers });
  const t = await translatorFor(request, user.language);
  if (!approvalAllowed(request, [new URL(appUrl(request)).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403, headers });
  }
  if (!googleReady()) return Response.json({ error: t("Not found") }, { status: 404, headers });
  const body = (await request.json().catch(() => ({}))) as { connectionId?: unknown };
  if (typeof body.connectionId !== "string" || !body.connectionId || body.connectionId.length > 40) return Response.json({ error: t("Not found") }, { status: 404, headers });
  try {
    const { token } = await googlePickerToken(user.id, body.connectionId);
    const { apiKey, appId } = pickerSettings();
    // In development with the stand-in (FLASH_CONNECT_MOCK), the page lists the stand-in's files instead of opening Google's Picker.
    const mock = mockOrigin();
    return Response.json({ token, apiKey, appId, ...(mock && { mock: `${mock}/google/picker` }) }, { headers });
  } catch (err) {
    if (err instanceof ConnectError) {
      const status = err.code === "limit" ? 429 : err.code === "unverified" ? 403 : err.code === "gone" ? 404 : err.code === "reconnect" ? 409 : 400;
      return Response.json({ error: problemText(err.code, t), code: err.code }, { status, headers });
    }
    console.error("[flash] a Google Picker token failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500, headers });
  }
}
