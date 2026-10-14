import { translatorFor } from "@/lib/server/i18n.ts";
import { fromOwnPage } from "@/lib/server/auth.ts";
import { clearPendingCookie, finishSignIn } from "@/lib/server/two-factor.ts";

/** The second step of signing in: the code from the authenticator app, or a recovery code. */
export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  // This signs in, so only Flash's own page may use it (see fromOwnPage).
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { code?: string };
  const result = await finishSignIn(request, String(body.code ?? "").slice(0, 40));
  if (result.ok) {
    const headers = new Headers();
    headers.append("Set-Cookie", result.cookie);
    headers.append("Set-Cookie", clearPendingCookie());
    return Response.json({ ok: true, next: result.next }, { headers });
  }
  if (result.reason === "busy") return Response.json({ error: t("Too many attempts. Try again in 15 minutes.") }, { status: 429 });
  if (result.reason === "expired") {
    return Response.json(
      { error: t("This sign-in has timed out. Please sign in again."), code: "expired" },
      { status: 400, headers: { "Set-Cookie": clearPendingCookie() } },
    );
  }
  return Response.json({ error: t("That code isn't right. Check your authenticator app and try again.") }, { status: 400 });
}
