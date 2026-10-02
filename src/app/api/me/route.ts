import { getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { balance, ensureMonthlyCredits, recentActivity } from "@/lib/server/credits.ts";
import { run } from "@/lib/server/db.ts";
import { pricingInfo } from "@/lib/server/pricing.ts";
import { planSummary } from "@/lib/server/subscriptions.ts";
import { isVerified } from "@/lib/server/account.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  await ensureMonthlyCredits(user.id);
  return Response.json({
    user: { id: user.id, email: user.email, name: user.name, preferences: user.preferences },
    isAdmin: isAdmin(user),
    verified: isVerified(user),
    credits: await balance(user.id),
    plan: await planSummary(user.id),
    activity: await recentActivity(user.id),
    ...pricingInfo(),
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
