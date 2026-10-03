import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { addPurchase } from "@/lib/server/credits.ts";
import { createCheckout, demoPurchases, paymentsEnabled } from "@/lib/server/stripe.ts";
import { randomId } from "@/lib/server/ids.ts";
import { CREDIT_PACKS } from "@/lib/credits.ts";

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { pack: packId } = (await request.json().catch(() => ({}))) as { pack?: string };
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) return Response.json({ error: "Unknown credit pack." }, { status: 400 });

  if (demoPurchases()) {
    await addPurchase(user.id, pack.id, `demo:${randomId()}`);
    return Response.json({ demo: true });
  }
  if (!paymentsEnabled()) {
    return Response.json({ error: "Paid plans and top-ups are coming soon." }, { status: 503 });
  }
  try {
    const url = await createCheckout(pack, user.id, user.email, appUrl(request));
    return Response.json({ url });
  } catch (err) {
    console.error("[flash] checkout failed", err);
    return Response.json({ error: "Couldn't open checkout. Please try again." }, { status: 502 });
  }
}
