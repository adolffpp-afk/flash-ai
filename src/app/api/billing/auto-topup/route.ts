import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { autoTopUp, setAutoTopUp } from "@/lib/server/auto-topup.ts";
import { translatorFor } from "@/lib/server/i18n.ts";

/** The signed-in person's auto top-up: on or off, which pack, and below what balance. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json(await autoTopUp(user.id));
}

/** Saves their choice. Turning it on without a saved card answers with a Stripe page to save one. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; pack?: unknown; below?: unknown };
  try {
    const result = await setAutoTopUp(
      user,
      { enabled: body.enabled === true, pack: String(body.pack ?? ""), below: Number(body.below) },
      appUrl(request),
    );
    if (result.error === "payments off") return Response.json({ error: t("Paid plans and top-ups are coming soon.") }, { status: 503 });
    if (result.error) return Response.json({ error: t("Unknown credit pack.") }, { status: 400 });
    return Response.json({ ...(await autoTopUp(user.id)), url: result.url });
  } catch (err) {
    console.error("[flash] auto top-up setup failed", err);
    return Response.json({ error: t("Couldn't open checkout. Please try again.") }, { status: 502 });
  }
}
