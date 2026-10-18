import { all, one, run } from "./db.ts";
import { siteDomains } from "./domains.ts";
import { SEO_VERSION, scanPage, type SeoFacts } from "../seo-scan.ts";
import { evaluate, issueCount, type SeoContext, type SeoReport } from "../seo-rules.ts";
import { hasOwnCanonical } from "../site-preview.ts";
import { ANYONE, can } from "../data-rules.ts";
import { collectionRule } from "./site-data.ts";
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

/**
 * What the check needs to know besides the page: its address on Flash, its own domains and those of
 * them that show it (see siteDomains), and (for a page whose scripts hold blanks like [Price]) whether
 * every shared list it reads has entries.
 */
export async function seoContext(slug: string, known?: { domains: string[]; live: string[] }, facts?: SeoFacts | null): Promise<SeoContext> {
  const { domains, live } = known ?? (await siteDomains(slug));
  const ctx: SeoContext = { slug, appBase: appBase(), domains, live };
  if (await listsFilled(slug, facts)) ctx.listsFilled = true;
  return ctx;
}

/**
 * Whether every shared list a page reads (flashDB.list("menu")) has entries visitors may see, with the
 * fields its sample entries' blanks are in ([{ price: "[Price]" }], shown only while a list is empty, as
 * builder.ts asks: see seo-scan.ts) and none of those blanks, so visitors don't see the samples. A list
 * named while the page runs can't be looked at, so it never counts as filled.
 */
async function listsFilled(slug: string, facts: SeoFacts | null | undefined): Promise<boolean> {
  if (!facts?.scriptPlaceholders?.length || !facts.sampleFields?.length || !facts.lists?.length || facts.lists.includes("*")) return false;
  for (const list of facts.lists) {
    const rule = await collectionRule(slug, list);
    if (!rule || !can(rule.rule, "read", ANYONE)) return false;
    if (!(await one("SELECT 1 AS found FROM site_records WHERE site_slug = ? AND owner = '' AND collection = ? LIMIT 1", [slug, list]))) return false;
  }
  const where = `site_slug = ? AND owner = '' AND collection IN (${facts.lists.map(() => "?").join(", ")})`;
  for (const field of facts.sampleFields) {
    if (!(await one(`SELECT 1 AS found FROM site_records WHERE ${where} AND json_extract(data, ?) IS NOT NULL LIMIT 1`, [slug, ...facts.lists, `$."${field}"`]))) return false;
  }
  const blanks = facts.scriptPlaceholders.map(() => "instr(data, ?) > 0").join(" OR ");
  return !(await one(`SELECT 1 AS found FROM site_records WHERE ${where} AND (${blanks}) LIMIT 1`, [slug, ...facts.lists, ...facts.scriptPlaceholders]));
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
  const facts = saved ?? fresh?.facts;
  const ctx = await seoContext(site.slug, undefined, facts);
  return { checkedAt: fresh?.updatedAt ?? Number(site.updated_at), ctx, report: evaluate(facts, ctx) };
}
