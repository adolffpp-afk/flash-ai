/*
 * Visitor stats for published sites: how many page loads and people each day, and where they came
 * from. No cookies and nothing sent to other companies: a visitor is a hash of the day, the site,
 * their address and browser, kept for a month only to count people once a day.
 */
import { all, run } from "./db.ts";
import { sha256 } from "./ids.ts";
import { clientIp } from "./limits.ts";

const DAYS_SHOWN = 30;
const KEEP_VISITORS_DAYS = 31;
const KEEP_VIEWS_DAYS = 400;
const MAX_SOURCE = 60;
// Crawlers, link previews and uptime checkers aren't people.
const ROBOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|go-http|java\/|monitor|uptime|scan/i;

/** The UTC day of a time, like "2026-10-04". */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Where a visit came from: the other website's name, or "" when typed in, bookmarked or from the site itself. */
export function visitSource(referrer: string | null, host: string | null): string {
  if (!referrer) return "";
  try {
    const from = new URL(referrer);
    if (!from.protocol.startsWith("http")) return "";
    const name = from.hostname.toLowerCase().replace(/^www\./, "");
    if (!name || name === (host ?? "").toLowerCase().split(":")[0].replace(/^www\./, "")) return "";
    // Search engines and social apps send many subdomains (m.facebook.com, l.instagram.com).
    const known = name.match(/(?:^|\.)(google|bing|duckduckgo|yahoo|facebook|instagram|tiktok|youtube|linkedin|pinterest|reddit)\.[a-z.]+$/);
    if (known) return known[1] === "google" ? "google.com" : `${known[1]}.com`;
    if (name === "t.co") return "x.com";
    return name.slice(0, MAX_SOURCE);
  } catch {
    return "";
  }
}

/** Whether a page request is a person looking at the page, not a robot or a prefetch. */
export function isPersonVisit(request: Request): boolean {
  const agent = request.headers.get("user-agent") ?? "";
  if (!agent || ROBOT.test(agent)) return false;
  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  return !/prefetch|prerender/i.test(purpose);
}

/** Counts one load of a published site. Never throws: stats must not break a site. */
export async function recordVisit(slug: string, request: Request, ownerId?: string | null, at = Date.now()): Promise<void> {
  if (!isPersonVisit(request)) return;
  try {
    // The owner checking their own site isn't a visitor.
    if (ownerId && (await all("SELECT 1 FROM sites WHERE slug = ? AND user_id = ?", [slug, ownerId])).length) return;
    const day = dayOf(at);
    const source = visitSource(request.headers.get("referer"), request.headers.get("host"));
    const visitor = sha256(`${day}|${slug}|${clientIp(request)}|${request.headers.get("user-agent")}`).slice(0, 24);
    // INSERT … SELECT so a visit to a site that was just unpublished writes nothing.
    await run(
      `INSERT INTO site_visits (site_slug, day, source, views) SELECT slug, ?, ?, 1 FROM sites WHERE slug = ?
       ON CONFLICT (site_slug, day, source) DO UPDATE SET views = views + 1`,
      [day, source, slug],
    );
    await run("INSERT OR IGNORE INTO site_visitors (site_slug, day, visitor) SELECT slug, ?, ? FROM sites WHERE slug = ?", [day, visitor, slug]);
    // Now and then, forget old visitors and very old counts.
    if (Math.random() < 0.02) {
      await run("DELETE FROM site_visitors WHERE day < ?", [dayOf(at - KEEP_VISITORS_DAYS * 86_400_000)]);
      await run("DELETE FROM site_visits WHERE day < ?", [dayOf(at - KEEP_VIEWS_DAYS * 86_400_000)]);
    }
  } catch (err) {
    console.error("[flash] visit not counted", err);
  }
}

export type VisitStats = {
  days: { day: string; views: number; visitors: number }[];
  views: number;
  visitors: number;
  sources: { source: string; views: number }[];
};

/** The last 30 days of a site's visits, oldest first, with days without visits as zero. */
export async function visitStats(slug: string, at = Date.now()): Promise<VisitStats> {
  const since = dayOf(at - (DAYS_SHOWN - 1) * 86_400_000);
  const views = await all<{ day: string; n: number }>(
    "SELECT day, SUM(views) AS n FROM site_visits WHERE site_slug = ? AND day >= ? GROUP BY day",
    [slug, since],
  );
  const people = await all<{ day: string; n: number }>(
    "SELECT day, COUNT(*) AS n FROM site_visitors WHERE site_slug = ? AND day >= ? GROUP BY day",
    [slug, since],
  );
  const sources = await all<{ source: string; n: number }>(
    "SELECT source, SUM(views) AS n FROM site_visits WHERE site_slug = ? AND day >= ? GROUP BY source ORDER BY n DESC LIMIT 8",
    [slug, since],
  );
  const viewsOn = new Map(views.map((r) => [r.day, Number(r.n)]));
  const peopleOn = new Map(people.map((r) => [r.day, Number(r.n)]));
  const days = Array.from({ length: DAYS_SHOWN }, (_, i) => {
    const day = dayOf(at - (DAYS_SHOWN - 1 - i) * 86_400_000);
    return { day, views: viewsOn.get(day) ?? 0, visitors: peopleOn.get(day) ?? 0 };
  });
  return {
    days,
    views: days.reduce((n, d) => n + d.views, 0),
    // People counted once a day, so someone who came on two days counts twice.
    visitors: days.reduce((n, d) => n + d.visitors, 0),
    sources: sources.map((r) => ({ source: r.source, views: Number(r.n) })),
  };
}
