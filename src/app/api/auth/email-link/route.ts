import { appUrl, createSession, isSecure } from "@/lib/server/auth.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { redeemSignInLink, signInWithEmail } from "@/lib/server/signin.ts";

/**
 * Signs in with the code from a sign-in link. The link opens a page with a button that calls
 * this, so email scanners that open links don't use it up.
 */
export async function POST(request: Request) {
  // Only this site's own page may use a link, so another site can't sign a visitor into its account.
  const origin = request.headers.get("origin");
  if (origin && origin !== appUrl(request) && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Open the link from your email again." }, { status: 403 });
  }
  if (await overLimit(`link-use:${clientIp(request)}`, 30, 15 * 60_000)) {
    return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const link = await redeemSignInLink(body.token ?? "");
  if (!link) {
    return Response.json({ error: "This link has expired or was already used. Ask for a new one." }, { status: 400 });
  }
  const userId = await signInWithEmail(link.email, request);
  const cookie = await createSession(userId, isSecure(request));
  return Response.json({ ok: true, next: link.next }, { headers: { "Set-Cookie": cookie } });
}
