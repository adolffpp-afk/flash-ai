import { appUrl, getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { ensureMonthlyCredits, recentActivity, spendable } from "@/lib/server/credits.ts";
import { run } from "@/lib/server/db.ts";
import { pricingInfo } from "@/lib/server/pricing.ts";
import { planSummary } from "@/lib/server/subscriptions.ts";
import { isVerified } from "@/lib/server/account.ts";
import { referralStats } from "@/lib/server/referrals.ts";
import { teamSummary } from "@/lib/server/teams.ts";
import {
  REFERRAL_FRIEND_SHARE,
  REFERRAL_PENDING_DAYS,
  REFERRAL_REFERRER_CAP,
  REFERRAL_REFERRER_SHARE,
} from "@/lib/credits.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  await ensureMonthlyCredits(user.id);
  const credits = await spendable(user.id);
  const { code, ...referrals } = await referralStats(user.id);
  return Response.json({
    user: { id: user.id, email: user.email, name: user.name, preferences: user.preferences },
    isAdmin: isAdmin(user),
    verified: isVerified(user),
    // Everything the user can spend, a team's shared pool included.
    credits: credits.total,
    teamCredits: credits.pool,
    plan: await planSummary(user.id),
    team: await teamSummary(user.id),
    referral: {
      link: `${appUrl(request)}/?ref=${code}`,
      ...referrals,
      friendShare: REFERRAL_FRIEND_SHARE,
      referrerShare: REFERRAL_REFERRER_SHARE,
      referrerCap: REFERRAL_REFERRER_CAP,
      pendingDays: REFERRAL_PENDING_DAYS,
    },
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
