import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one, run } from "@/lib/server/db.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { clearLimit, countOf, overLimit } from "@/lib/server/limits.ts";
import { domainsForSite, pointsAtFlash } from "@/lib/server/domains.ts";
import { cacheGet, cacheKey, cachePut } from "@/lib/server/source-fetch.ts";
import { appBase } from "@/lib/server/seo.ts";
import { parseRecord, REFUSED, runLock, runPageSpeed, type PageSpeedError, type PageSpeedRecord, type PageSpeedRun } from "@/lib/server/pagespeed.ts";
import { preferredDomain } from "@/lib/seo-rules.ts";
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
 * Checks the owner's live app with Google PageSpeed Insights, at its address on Flash or on its own
 * domain ({ address: "flash" | "domain" }: never an address from the request). A check of the same
 * version at the same address within a day is answered from the one saved, unless Google couldn't do
 * the phone's or the computer's half: then only that half is asked again. One app is checked once at a
 * time, and each owner a few times an hour. Free: it never charges anything.
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

  let url = `${appBase()}/p/${site.slug}`;
  if (body?.address === "domain") {
    const domain = preferredDomain(await domainsForSite(site.slug));
    if (!domain) return Response.json({ error: t("Not found") }, { status: 400 });
    // A domain that lapsed or points elsewhere would have Google test someone else's page.
    if (!(await pointsAtFlash(domain))) {
      return Response.json({ code: "domain_not_connected", error: t("Your domain doesn't point at Flash yet, so Google can't check your app there.") }, { status: 409 });
    }
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
  // Held for the whole run: the app's AI says no to Lighthouse meanwhile (see the ai route).
  const lock = runLock(site.slug);
  const running = () =>
    Response.json({ code: "running", error: t("Google is still checking this page. The result shows here when it's done.") }, { status: 409 });
  // Waiting for a check already going doesn't use up one of the owner's.
  if ((await countOf(lock)) > 0) return running();
  if (await overLimit(`pagespeed:${user.id}`, 10, HOUR)) return Response.json({ error: t("Too many requests. Try again in an hour.") }, { status: 429 });
  if (await overLimit(`pagespeed-day:${user.id}`, 30, DAY)) return Response.json({ error: t("Too many tries today. Please try again tomorrow.") }, { status: 429 });
  if (await overLimit(lock, 1, 3 * MINUTE)) return running();

  try {
    // Both side by side, or only the half that failed last time, each with when Google ran it (a kept
    // half saved before halves had their own time is as old as its check). Never the request's
    // signal: the result is kept even when the owner closes the page.
    const ask = async (strategy: "mobile" | "desktop"): Promise<PageSpeedRun> => {
      const kept = same?.[strategy];
      if (kept?.ok) return { ...kept, at: kept.at ?? same!.at };
      const result = await runPageSpeed(url, strategy);
      return result.ok ? { ...result, at: Date.now() } : result;
    };
    const [mobile, desktop] = await Promise.all([ask("mobile"), ask("desktop")]);
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
  }
}
