import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one, run } from "@/lib/server/db.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { clearLimit, countOf, giveBackOne, takeOne } from "@/lib/server/limits.ts";
import { pointsAtFlash, siteDomains } from "@/lib/server/domains.ts";
import { cacheGet, cacheKey, cachePut } from "@/lib/server/source-fetch.ts";
import { appBase } from "@/lib/server/seo.ts";
import { ownerChecks, pagespeedRoom, parseRecord, REFUSED, runLock, runPageSpeed, type PageSpeedError, type PageSpeedRecord, type PageSpeedRun } from "@/lib/server/pagespeed.ts";
import { testDomain } from "@/lib/seo-rules.ts";
import type { Translate } from "@/lib/i18n.ts";

export const dynamic = "force-dynamic";
// Google takes up to about 85 seconds for a page; both checks run side by side.
export const maxDuration = 120;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What the owner is told when neither check worked, and the status it goes with. */
function failed(t: Translate, error: PageSpeedError): Response {
  const said: Record<PageSpeedError, [number, string]> = {
    quota: [503, t("Google's speed check isn't available right now. Flash's own check above still works.")],
    busy: [503, t("Google's free speed check is busy right now. Try again later.")],
    slow: [504, t("Google took too long to check your page. Try again later.")],
    unreachable: [502, t("Google couldn't load your page this time. Try again in a few minutes.")],
  };
  const [status, message] = said[error];
  return Response.json({ code: error, error: message }, { status });
}

/**
 * How many times an owner may be told here, in an hour, that their domain doesn't point at Flash, and
 * how many of their presses on a domain may run at once: a press that goes on gives its lookup back.
 */
const DOMAIN_LOOKUPS = 10;

/**
 * Checks the owner's live app with Google PageSpeed Insights, at its address on Flash or on its own
 * domain ({ address: "flash" | "domain" }: never an address from the request). A check of the same
 * version at the same address within a day is answered from the one saved, unless Google couldn't do
 * the phone's or the computer's half: then only that half is asked again. A saved check, a failure
 * remembered, Google refusing, a check already going and Flash's daily allowance being used up are
 * answered for free, before anything is asked or counted, and a press Flash's own limits keep from
 * Google once it was counted gives the owner's check back. One app is checked once at a time, and each
 * owner a few times an hour and a UTC day (ownerChecks). Free: it never charges anything.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/pagespeed">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  const site = await one<{ slug: string; updated_at: number; pagespeed: string }>("SELECT slug, updated_at, pagespeed FROM sites WHERE slug = ? AND user_id = ?", [
    slug,
    user.id,
  ]);
  if (!site) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { address?: unknown };
  const version = Number(site.updated_at);

  // Whether the domain points at Flash is asked of Vercel only when Google is about to test it (below).
  let url = `${appBase()}/p/${site.slug}`;
  const domain = body?.address === "domain" ? testDomain(await siteDomains(site.slug)) : null;
  if (body?.address === "domain") {
    if (!domain) return Response.json({ error: t("Not found") }, { status: 404 });
    url = `https://${domain}/`;
  }

  // The same version at the same address, checked within a day: no new check, unless half of it failed.
  const saved = parseRecord(site.pagespeed);
  const same = saved && saved.url === url && saved.for === version && Date.now() - saved.at < DAY ? saved : null;
  if (same?.mobile.ok && same.desktop.ok) return Response.json({ pagespeed: same, cached: true });
  const failKey = cacheKey("pagespeed-fail", site.slug, String(version), url);
  const failedBefore = await cacheGet<PageSpeedError>(failKey);
  if (failedBefore) return failed(t, failedBefore);

  if (await cacheGet<number>(REFUSED)) {
    return Response.json({ code: "pagespeed_unavailable", error: t("Google's speed check isn't available right now. Flash's own check above still works.") }, { status: 503 });
  }
  // Held for the whole run: one check of an app at a time.
  const lock = runLock(site.slug);
  const running = () =>
    Response.json({ code: "running", error: t("Google is still checking this page. The result shows here when it's done.") }, { status: 409 });
  // Waiting for a check already going doesn't use up one of the owner's.
  if ((await countOf(lock)) > 0) return running();
  // The owner's checks today are counted by the UTC day Flash's daily allowance counts by, from this
  // moment, and this press's requests come from that day's allowance: one owner's 5 keyless checks a
  // day are at most 10 of that day's 200.
  const pressed = Date.now();
  // Flash's daily allowance for every owner together (read only) can't take what this press would ask
  // Google, both halves or the one that failed: busy, without using one of the owner's checks.
  if (!(await pagespeedRoom(same ? [same.mobile, same.desktop].filter((r) => !r.ok).length : 2, pressed))) return failed(t, "busy");
  const caps = ownerChecks();
  const hourly = `pagespeed:${user.id}`;
  const days = `pagespeed-day:${user.id}:`;
  const daily = `${days}${new Date(pressed).toISOString().slice(0, 10)}`;
  const thisHour = () =>
    Response.json({ error: t("You've used this hour's checks with Google ({count} an hour). Try again in an hour.", { count: caps.hour.toLocaleString(t.locale) }) }, { status: 429 });
  const today = () =>
    Response.json({ error: t("You've used today's checks with Google ({count} a day). Try again tomorrow.", { count: caps.day.toLocaleString(t.locale) }) }, { status: 429 });
  // Over a limit, nothing is asked or written.
  if ((await countOf(hourly)) >= caps.hour) return thisHour();
  const usedToday = await countOf(daily);
  if (usedToday >= caps.day) return today();
  const lookups = `pagespeed-domain:${user.id}`;
  // When the window ends that each of this press's counts was taken from.
  const took = new Map<string, number>();
  /**
   * Takes one of key's max in its window, or says no without writing anything once they're all used:
   * in one statement (takeOne), so of two presses at the same moment for the last one, one takes it.
   */
  const take = async (key: string, max: number, windowMs: number) => {
    const until = (await countOf(key)) < max ? await takeOne(key, max, windowMs) : null;
    if (until !== null) took.set(key, until);
    return until !== null;
  };
  /**
   * Gives back one of each key's counts this press took, into the window it took it from: a press
   * that runs past the end of the hour (or the UTC day) gives nothing to the next one.
   */
  const giveBack = (...keys: string[]) => giveBackOne(keys.flatMap((key) => (took.has(key) ? [[key, took.get(key)!] as [string, number]] : [])));
  if (domain) {
    // Asking Vercel (whose answer is noted with the domain, see domainStatus) has a limit of its own,
    // so a domain that doesn't point at Flash yet uses up none of the owner's checks. A domain that
    // lapsed or points elsewhere would have Google test someone else's page. One that points at Flash
    // gives the lookup back as the press ends, so a check, or a press Flash's own limits keep from
    // Google (another of the app's, the owner's last check taken meanwhile, or busy), uses none.
    if (!(await take(lookups, DOMAIN_LOOKUPS, HOUR))) return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
    if (!(await pointsAtFlash(domain))) {
      return Response.json({ code: "domain_not_connected", error: t("Your domain doesn't point at Flash yet, so Google can't check your app there.") }, { status: 409 });
    }
  }
  // Taken in one statement: of two presses of the app at the same moment, one holds it, and only its
  // finally lets go.
  if ((await takeOne(lock, 1, 3 * MINUTE)) === null) {
    if (domain) await giveBack(lookups);
    return running();
  }

  try {
    // Counted once this press holds the app's check, so a press that lost the race to another uses none.
    if (!(await take(hourly, caps.hour, HOUR))) return thisHour();
    // Until the next UTC midnight. The owner's first check of a day clears their counts of earlier days.
    if (!(await take(daily, caps.day, DAY - (pressed % DAY)))) {
      await giveBack(hourly);
      return today();
    }
    if (!usedToday) await run("DELETE FROM rate_limits WHERE key >= ? AND key < ?", [days, daily]);
    // Both side by side, or only the half that failed last time, each with when Google ran it (a kept
    // half saved before halves had their own time is as old as its check). Never the request's
    // signal: the result is kept even when the owner closes the page.
    let reachedGoogle = false;
    const ask = async (strategy: "mobile" | "desktop"): Promise<PageSpeedRun> => {
      const kept = same?.[strategy];
      if (kept?.ok) return { ...kept, at: kept.at ?? same!.at };
      const result = await runPageSpeed(url, strategy, { at: pressed });
      if (result.ok || result.error !== "busy") reachedGoogle = true;
      return result.ok ? { ...result, at: Date.now() } : result;
    };
    const [mobile, desktop] = await Promise.all([ask("mobile"), ask("desktop")]);
    // Busy is the one answer that never reached Google: Flash's few requests a second, or the day's last
    // requests, were taken by other presses meanwhile. When every half asked was busy, the owner's
    // check is given back, as when the allowance had no room.
    if (!reachedGoogle) await giveBack(hourly, daily);
    // Google couldn't load or finish this version: the same answer for a while, without asking again.
    const error = !mobile.ok ? mobile.error : !desktop.ok ? desktop.error : null;
    if (error === "unreachable" || error === "slow") await cachePut(failKey, error, 10 * MINUTE);
    if (!mobile.ok && !desktop.ok) return failed(t, mobile.error);
    // As old as its older half: a day from then, it's asked for again, both halves.
    const at = Math.min(...[mobile, desktop].map((r) => (r.ok && r.at ? r.at : Date.now())));
    const record: PageSpeedRecord = { v: 1, at, for: version, url, mobile, desktop };
    await run("UPDATE sites SET pagespeed = ? WHERE slug = ? AND user_id = ?", [JSON.stringify(record), site.slug, user.id]);
    return Response.json({ pagespeed: record });
  } finally {
    await clearLimit(lock);
    if (domain) await giveBack(lookups);
  }
}
