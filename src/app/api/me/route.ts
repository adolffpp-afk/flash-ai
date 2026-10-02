import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { balance, ensureMonthlyCredits, recentActivity } from "@/lib/server/credits.ts";
import { run } from "@/lib/server/db.ts";
import { CREDIT_COSTS, CREDIT_PACKS, FREE_MONTHLY_CREDITS } from "@/lib/credits.ts";
import { paymentsEnabled } from "@/lib/server/stripe.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  await ensureMonthlyCredits(user.id);
  return Response.json({
    user: { id: user.id, email: user.email, name: user.name, preferences: user.preferences },
    credits: await balance(user.id),
    activity: await recentActivity(user.id),
    costs: CREDIT_COSTS,
    packs: CREDIT_PACKS,
    freeMonthly: FREE_MONTHLY_CREDITS,
    paymentsEnabled: paymentsEnabled(),
  });
}

export async function PATCH(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { name?: string; preferences?: string };
  if (typeof body.preferences === "string") {
    await run("UPDATE users SET preferences = ? WHERE id = ?", [body.preferences.slice(0, 2000), user.id]);
  }
  if (typeof body.name === "string" && body.name.trim()) {
    await run("UPDATE users SET name = ? WHERE id = ?", [body.name.trim().slice(0, 80), user.id]);
  }
  return Response.json({ ok: true });
}
