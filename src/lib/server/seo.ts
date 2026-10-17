import { all, one, run } from "./db.ts";
import { domainsForSite } from "./domains.ts";
import { SEO_VERSION, scanPage, type SeoFacts } from "../seo-scan.ts";
import { evaluate, issueCount, type SeoContext, type SeoReport } from "../seo-rules.ts";
import { hasOwnCanonical } from "../site-preview.ts";
import { SITE_URL } from "../../app/site.ts";

/*
 * Flash's search check (SEO) on the server: the facts read from an app's page are saved with it, in
 * the same UPDATE that saves the page (see sites.ts), so they can never be about another version.
 * Apps published before the check existed, or read by an older version of it, are read again the
 * first time they're looked at (refreshSeo), as data rules are (see site-data.ts). Reading a page
 * takes milliseconds and calls nothing: it's free.
 */

/** The facts to save with a page, as sites.seo. A page that can't be read is saved as such: no score. */
export function seoFactsFor(html: string): string {
  try {
    return JSON.stringify(scanPage(html));
  } catch {
    return JSON.stringify({ v: SEO_VERSION, error: true });
  }
}

/** Saved facts, or null when there are none, they can't be read, or an older version of the check read them. */
export function parseFacts(text: string | null | undefined): SeoFacts | null {
  if (!text) return null;
  try {
    const facts = JSON.parse(text) as SeoFacts;
    return facts && typeof facts === "object" && facts.v === SEO_VERSION ? facts : null;
  } catch {
    return null;
  }
}

/**
 * Whether a page names its own main address (canonical), so Flash adds none when it serves it: what
 * the search check read in it (a tag anywhere in its code), so the two always agree. A page it hasn't
 * read yet (published before it, or read by an older version) is read now, and its facts kept, as
 * when its owner looks. Only a page it can't read at all is judged by a look at its start.
 */
export async function namesOwnCanonical(site: { slug: string; html: string; seo: string | null; updated_at: number }): Promise<boolean> {
  let facts = parseFacts(site.seo);
  if (!facts) {
    const text = seoFactsFor(site.html);
    facts = parseFacts(text);
    await run("UPDATE sites SET seo = ? WHERE slug = ? AND updated_at = ?", [text, site.slug, Number(site.updated_at)]).catch((err) =>
      console.error("[flash] search check failed", err),
    );
  }
  return facts && !facts.error ? facts.canonicalCount > 0 : hasOwnCanonical(site.html);
}

/** Flash's own address, as published apps are linked from it (FLASH_APP_URL, else the live site). */
export const appBase = () => (process.env.FLASH_APP_URL || SITE_URL).replace(/\/+$/, "");

/** What the check needs to know besides the page: its address on Flash and its own domains. */
export async function seoContext(slug: string, domains?: string[]): Promise<SeoContext> {
  return { slug, appBase: appBase(), domains: domains ?? (await domainsForSite(slug)) };
}

/** A site's score and how many things there are to fix, or null when there's no score. */
export function seoSummary(facts: SeoFacts | null, ctx: SeoContext): { score: number; issues: number } | null {
  if (!facts) return null;
  const report = evaluate(facts, ctx);
  return report.score === null ? null : { score: report.score, issues: issueCount(report) };
}

/**
 * Reads a site's page again and keeps its facts, unless the page was replaced while it was read:
 * publishing saves the new page's facts with it. Null when there's no such site.
 */
export async function refreshSeo(slug: string): Promise<{ facts: SeoFacts | null; updatedAt: number } | null> {
  const site = await one<{ html: string; updated_at: number }>("SELECT html, updated_at FROM sites WHERE slug = ?", [slug]);
  if (!site) return null;
  const text = seoFactsFor(site.html);
  await run("UPDATE sites SET seo = ? WHERE slug = ? AND updated_at = ?", [text, slug, Number(site.updated_at)]);
  return { facts: parseFacts(text), updatedAt: Number(site.updated_at) };
}

/**
 * Reads again the user's sites whose facts are missing or old, one at a time (up to 20, the most a
 * user publishes), after the list was answered: the next look at the list shows their scores.
 */
export async function refreshStale(userId: string): Promise<void> {
  const rows = await all<{ slug: string; seo: string }>("SELECT slug, seo FROM sites WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20", [userId]);
  for (const row of rows) {
    if (parseFacts(row.seo)) continue;
    await refreshSeo(row.slug).catch((err) => console.error("[flash] search check failed", err));
  }
}

/**
 * A site's whole check for its owner, read again first when its facts are missing or old.
 * checkedAt is the version of the page it's about (sites.updated_at).
 */
export async function seoReport(site: { slug: string; seo: string; updated_at: number }): Promise<{ checkedAt: number; ctx: SeoContext; report: SeoReport }> {
  const saved = parseFacts(site.seo);
  const fresh = saved ? null : await refreshSeo(site.slug);
  const ctx = await seoContext(site.slug);
  return { checkedAt: fresh?.updatedAt ?? Number(site.updated_at), ctx, report: evaluate(saved ?? fresh?.facts, ctx) };
}
