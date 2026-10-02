import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { isVerified, sendVerification } from "@/lib/server/account.ts";
import { verificationRequired } from "@/lib/server/email.ts";
import { overLimit } from "@/lib/server/limits.ts";

/** Sends the verification email again. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!verificationRequired() || isVerified(user)) return Response.json({ ok: true, verified: true });
  if (await overLimit(`verify:${user.id}`, 3, 3600_000)) {
    return Response.json({ error: "We've sent a few already. Check your spam folder, or try again in an hour." }, { status: 429 });
  }
  try {
    const devLink = await sendVerification(user, appUrl(request));
    return Response.json({ ok: true, devLink });
  } catch (err) {
    console.error("[flash] verification email failed", err);
    return Response.json({ error: "Couldn't send the email. Please try again." }, { status: 502 });
  }
}
