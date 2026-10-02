import { sendReset } from "@/lib/server/account.ts";
import { emailEnabled, demoEmails } from "@/lib/server/email.ts";
import { one } from "@/lib/server/db.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";

const HOUR = 3600_000;

/** "Forgot password": emails a one-hour reset link. Never says whether the account exists. */
export async function POST(request: Request) {
  if (!emailEnabled() && !demoEmails()) {
    return Response.json(
      { error: `Password reset isn't available right now. Email ${process.env.FLASH_CONTACT_EMAIL || "support@flash-app.dev"} for help.` },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  if ((await overLimit(`reset-ip:${clientIp(request)}`, 10, HOUR)) || (await overLimit(`reset:${email}`, 3, HOUR))) {
    return Response.json({ error: "Too many requests. Try again in an hour." }, { status: 429 });
  }
  const user = await one<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = ?", [email]);
  let devLink: string | undefined;
  if (user) {
    try {
      devLink = await sendReset(user, new URL(request.url).origin);
    } catch (err) {
      console.error("[flash] reset email failed", err);
    }
  }
  return Response.json({ ok: true, devLink });
}
