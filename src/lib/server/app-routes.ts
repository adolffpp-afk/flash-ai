import { appUrl, flowAccount, getUser, unauthorized } from "./auth.ts";
import { translatorFor } from "./i18n.ts";
import { overLimit } from "./limits.ts";
import { appFlowOwner, appOpenTo, appReady, type AppId } from "./app-signin.ts";
import { ConnectError, finishApp, problemText, sendToCanva, startApp } from "./connections.ts";
import { approvalAllowed } from "./pending-actions.ts";

/*
 * The routes of Figma's and Canva's Connect (src/app/api/connect/figma and .../canva), the same for
 * both, as Google Drive's are (see app-signin.ts): start answers with the service's sign-in page,
 * which the page opens; the callback is the redirect URL registered in Flash's app there. Start stores
 * a flow, so like an approval it is taken only from Flash's own page, with its exact Origin (S-3),
 * and only from an account whose email is confirmed. A service that isn't set up, or isn't open to
 * this user yet (before its review, only Flash's owners), isn't here at all (404). Both cost nothing.
 */

export function startRoute(id: AppId) {
  return async function POST(request: Request) {
    const headers = { "cache-control": "no-store" };
    const user = await getUser(request);
    if (!user) return unauthorized();
    const t = await translatorFor(request, user.language);
    const origin = appUrl(request);
    if (!approvalAllowed(request, [new URL(origin).origin, new URL(request.url).origin])) {
      return Response.json({ error: t("Please use Flash's own page.") }, { status: 403, headers });
    }
    if (!appOpenTo(id, user)) return Response.json({ error: t("Not found") }, { status: 404, headers });
    const body = (await request.json().catch(() => ({}))) as { connectionId?: unknown };
    try {
      const url = await startApp(id, user.id, { connectionId: typeof body.connectionId === "string" ? body.connectionId.slice(0, 40) : undefined }, origin);
      return Response.json({ url }, { headers });
    } catch (err) {
      if (err instanceof ConnectError) {
        const status = err.code === "limit" ? 429 : err.code === "too_many" ? 409 : err.code === "unverified" ? 403 : err.code === "gone" ? 404 : 400;
        return Response.json({ error: problemText(err.code, t), code: err.code }, { status, headers });
      }
      console.error(`[flash] starting the ${id} sign-in failed`, err instanceof Error ? err.name : "error");
      return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500, headers });
    }
  };
}

/**
 * The service's redirect: a code is traded only with the state of this signed-in user's own sign-in
 * (see finishApp); anything else trades nothing. The page it goes back to says only how it ended, in
 * Flash's own words: never the service's error text, the code or a token, and the code isn't passed
 * on as a referrer. In a browser signed in to several accounts, it is the account that started it.
 */
export function callbackRoute(id: AppId) {
  return async function GET(request: Request) {
    const params = new URL(request.url).searchParams;
    const { user, as } = await flowAccount(request, await appFlowOwner(id, params.get("state")));
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
    const go = (outcome: string) => new Response(null, { status: 303, headers: { ...headers, Location: `${appUrl(request)}/?connect=${outcome}${as}` } });
    if (!user || !appReady(id)) return go("failed");
    if (await overLimit(`connect-callback:${user.id}`, 30, 15 * 60_000)) return go("failed");
    const outcome = await finishApp(id, user.id, { state: params.get("state"), code: params.get("code"), error: params.get("error") }).catch((err) => {
      console.error(`[flash] the ${id} sign-in failed`, err instanceof Error ? err.name : "error");
      return "failed" as const;
    });
    return go(outcome);
  };
}

/**
 * Open in Canva (My creations): the user's own picture to their own Canva, then the new design's
 * editing link for the page to open. Taken only from Flash's own page with its exact Origin, like an
 * approval: it adds a file to the user's Canva. Costs nothing.
 */
export async function sendToCanvaRoute(request: Request) {
  const headers = { "cache-control": "no-store" };
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!approvalAllowed(request, [new URL(appUrl(request)).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403, headers });
  }
  if (!appReady("canva")) return Response.json({ error: t("Not found") }, { status: 404, headers });
  const body = (await request.json().catch(() => ({}))) as { fileId?: unknown };
  try {
    const sent = await sendToCanva(user.id, typeof body.fileId === "string" ? body.fileId.slice(0, 60) : "");
    if ("url" in sent) return Response.json({ url: sent.url }, { headers });
    return Response.json({ error: t(sent.problem) }, { status: 502, headers });
  } catch (err) {
    if (err instanceof ConnectError) {
      const status = err.code === "limit" ? 429 : err.code === "unverified" ? 403 : err.code === "gone" ? 404 : err.code === "reconnect" ? 409 : 400;
      const text = err.code === "bad_input" ? t("That picture can't go to Canva: only pictures you made in Flash, up to 25 MB.") : problemText(err.code, t);
      return Response.json({ error: text, code: err.code }, { status, headers });
    }
    console.error("[flash] open in canva failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500, headers });
  }
}
