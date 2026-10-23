import { after } from "next/server";
import { appUrl, getUser, isAdmin, jarSessions, unauthorized } from "@/lib/server/auth.ts";
import { maybeAutoTopUp } from "@/lib/server/auto-topup.ts";
import { ensureMonthlyCredits, recentActivity, spendable } from "@/lib/server/credits.ts";
import { one, run } from "@/lib/server/db.ts";
import { pricingInfo } from "@/lib/server/pricing.ts";
import { planSummary } from "@/lib/server/subscriptions.ts";
import { mobileMoneyFor } from "@/lib/server/pawapay.ts";
import { whereFrom } from "@/lib/server/where.ts";
import { MOBILE_MONEY_COUNTRIES, mobileMoneyCountry } from "@/lib/mobile-money.ts";
import { isVerified } from "@/lib/server/account.ts";
import { referralStats } from "@/lib/server/referrals.ts";
import { teamSummary } from "@/lib/server/teams.ts";
import { lowCreditsLevel } from "@/lib/server/low-balance.ts";
import { WORK_OPTIONS } from "@/lib/names.ts";
import { isLanguage } from "@/lib/languages.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { automationsReady } from "@/lib/server/automations.ts";
import { studioOpenTo } from "@/lib/server/studio.ts";
import { socialOpenTo } from "@/lib/server/social.ts";
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
  // Buys the person's auto top-up pack when they're low, after this answer (see auto-topup.ts).
  after(() => maybeAutoTopUp(user.id).catch((err) => console.error("[flash] auto top-up failed", err)));
  const credits = await spendable(user.id);
  const { code, ...referrals } = await referralStats(user.id);
  // Every account this browser is signed in to, for the profile menu's Switch account.
  const jar = await jarSessions(request);
  const listed = jar.entries.length ? jar.entries.map((e) => e.user) : [user];
  // Mobile money in Africa (see pawapay.ts): the countries, and the one the person seems to be in.
  const mobileMode = mobileMoneyFor(isAdmin(user));
  return Response.json({
    account: user.id,
    accounts: listed.map((u) => ({ id: u.id, email: u.email, name: u.name, nickname: u.nickname ?? "" })),
    user: { id: user.id, email: user.email, name: user.name, nickname: user.nickname ?? "", work: user.work ?? "", language: user.language ?? "", preferences: user.preferences },
    // Accounts made with Google or an email link have no password until they set one.
    hasPassword: Boolean((await one<{ p: string }>("SELECT password_hash AS p FROM users WHERE id = ?", [user.id]))?.p),
    isAdmin: isAdmin(user),
    verified: isVerified(user),
    // Whether automations can run for this account (set up here, and open to it: admins, and everyone once /admin opens them).
    automationsEnabled: await automationsReady(user),
    // Flash Infinity AI Studio: admins only until it's opened to everyone (see studio.ts).
    studioEnabled: studioOpenTo(user),
    // The Social hub: admins only until it's opened to everyone (see social.ts).
    socialEnabled: socialOpenTo(user),
    // Everything the user can spend, a team's shared pool included.
    credits: credits.total,
    teamCredits: credits.pool,
    // Below this the bell and Home say the credits are running low (see low-balance.ts).
    lowCredits: await lowCreditsLevel(user.id),
    plan: await planSummary(user.id),
    mobileMoney: mobileMode && {
      sandbox: mobileMode === "sandbox",
      country: mobileMoneyCountry(whereFrom(request).country)?.code ?? "",
      countries: MOBILE_MONEY_COUNTRIES.map((c) => ({ code: c.code, name: c.name, currency: c.currency })),
    },
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
  const body = (await request.json().catch(() => ({}))) as { name?: string; nickname?: string; work?: string; language?: string; preferences?: string };
  // A language that isn't on the list is refused before anything saves, so "ok" always means saved.
  if (body.language !== undefined && !isLanguage(body.language)) {
    const t = await translatorFor(request, user.language);
    return Response.json({ error: t("Pick a language from the list.") }, { status: 400 });
  }
  if (typeof body.preferences === "string") {
    await run("UPDATE users SET preferences = ? WHERE id = ?", [body.preferences.slice(0, 2000), user.id]);
  }
  if (typeof body.name === "string" && body.name.trim()) {
    await run("UPDATE users SET name = ? WHERE id = ?", [body.name.trim().slice(0, 80), user.id]);
  }
  if (typeof body.nickname === "string") {
    await run("UPDATE users SET nickname = ? WHERE id = ?", [body.nickname.trim().slice(0, 40), user.id]);
  }
  if (typeof body.work === "string" && (body.work === "" || (WORK_OPTIONS as readonly string[]).includes(body.work))) {
    await run("UPDATE users SET work = ? WHERE id = ?", [body.work, user.id]);
  }
  // Only a listed language (or "" for Automatic): it goes into Flash's instructions.
  if (isLanguage(body.language)) {
    await run("UPDATE users SET language = ? WHERE id = ?", [body.language, user.id]);
  }
  return Response.json({ ok: true });
}
