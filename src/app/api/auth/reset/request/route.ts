import { translatorFor } from "@/lib/server/i18n.ts";
import { sendReset } from "@/lib/server/account.ts";
import { appUrl, fromOwnPage } from "@/lib/server/auth.ts";
import { emailEnabled, demoEmails, tooManyFromNetwork } from "@/lib/server/email.ts";
import { one } from "@/lib/server/db.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";

const HOUR = 3600_000;

/** "Forgot password": emails a one-hour reset link. Never says whether the account exists. */
export async function POST(request: Request) {
  // Signed out, so the words follow the browser's language (see server/i18n.ts).
  const t = await translatorFor(request);
  if (!emailEnabled() && !demoEmails()) {
    return Response.json(
      {
        error: t("Password reset isn't available right now. Email {email} for help.", {
          email: process.env.FLASH_CONTACT_EMAIL || "support@flash-app.dev",
        }),
      },
      { status: 503 },
    );
  }
  // Only Flash's own page may ask, so other sites can't use visitors' browsers to send mail.
  if (!fromOwnPage(request)) return Response.json({ error: t("Please sign in on Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
  const ip = clientIp(request);
  if ((await overLimit(`reset-ip:${ip}`, 10, HOUR)) || (await overLimit(`reset:${email}`, 3, HOUR))) {
    return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  }
  if (await tooManyFromNetwork(ip)) return Response.json({ error: t("Too many tries today. Please try again tomorrow.") }, { status: 429 });
  const user = await one<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = ?", [email]);
  let devLink: string | undefined;
  if (user) {
    try {
      devLink = await sendReset(user, appUrl(request));
    } catch (err) {
      console.error("[flash] reset email failed", err);
    }
  }
  return Response.json({ ok: true, devLink });
}
