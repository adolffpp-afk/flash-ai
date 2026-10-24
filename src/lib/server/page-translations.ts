import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { RESULT_BYTES, SafeFetchError, safeFetch } from "./safe-fetch.ts";
import { translatePhrases } from "./site-translations.ts";
import type { User } from "./auth.ts";
import type { Translate } from "../i18n.ts";
import { framedPage, pageTitle, staticPage } from "../page-translate.ts";
import { siteLanguage, siteLanguageOf, type SiteLanguage } from "../site-languages.ts";
import { missingPhrases, pageLanguage, pagePhrases, translateCredits, translatePage } from "../site-translate.ts";

/*
 * Translate a website (see page-translate.ts): any page by its link, translated into a language and
 * kept for a month at a link of its own (/t/…), which anyone it's shared with can read. Fetched
 * through safe-fetch.ts, so no link reaches Flash's own network. Held at the most it can cost and
 * charged what it used, like Translate my app. The same page in the same language, asked again within
 * a day, is the copy already made, at no charge.
 */
export const KEEP_MS = 30 * 86_400_000;
const AGAIN_MS = 86_400_000;

export type FetchedPage = { url: string; html: string; title: string; phrases: string[]; from: SiteLanguage | null };

export type PageError = "link" | "fetch" | "not_html" | "empty" | "language" | "same" | "unavailable" | "credits" | "failed";

/** The page at a link, as Flash would translate it: without scripts, with its phrases. */
export async function fetchPage(link: unknown): Promise<FetchedPage | { error: PageError }> {
  const text = typeof link === "string" ? link.trim() : "";
  if (!text || text.length > 2000) return { error: "link" };
  // A link typed without https:// (or with http://) is asked for over https, as safe-fetch.ts only sends that.
  const withScheme = /^https?:\/\//i.test(text) ? text.replace(/^http:/i, "https:") : /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let res;
  try {
    // Only web pages, cut at 2 MB: the words a visitor reads first are at the start.
    res = await safeFetch(withScheme, { maxBytes: RESULT_BYTES, truncate: true, accept: ["html"], headers: { accept: "text/html,application/xhtml+xml" } });
  } catch (err) {
    // A blocked address (Flash's own network, a private one), a timeout, a server that isn't a website.
    if (err instanceof SafeFetchError) return { error: err.code === "bad_type" ? "not_html" : err.code === "blocked" ? "link" : "fetch" };
    if (err instanceof TypeError) return { error: "link" };
    throw err;
  }
  if (res.status >= 400) return { error: "fetch" };
  if (!/html/i.test(res.contentType)) return { error: "not_html" };
  const html = staticPage(res.body);
  const phrases = pagePhrases(html);
  if (!phrases.length) return { error: "empty" };
  return { url: res.url, html, title: pageTitle(html), phrases, from: siteLanguageOf(pageLanguage(html)) };
}

/** What translating a page costs, for the owner to see before it's done. */
export const pagePrice = (page: FetchedPage, lang: string) => translateCredits(page.phrases, lang);

export type PageTranslation = { id: string; url: string; title: string; lang: string; credits: number; missing: number };

/** Translates a fetched page into a language and keeps the copy; the copy made earlier today when there is one. */
export async function translateFetchedPage(user: Pick<User, "id">, page: FetchedPage, langId: unknown, t: Translate): Promise<PageTranslation | { error: PageError }> {
  const to = siteLanguage(langId);
  if (!to) return { error: "language" };
  if (page.from?.id === to.id) return { error: "same" };
  const recent = await one<{ id: string; title: string }>(
    "SELECT id, title FROM page_translations WHERE user_id = ? AND url = ? AND lang = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1",
    [user.id, page.url, to.id, now() - AGAIN_MS],
  );
  if (recent) return { id: recent.id, url: page.url, title: recent.title, lang: to.id, credits: 0, missing: 0 };

  const paid = await translatePhrases(user, page.phrases, page.from, to, page.title, "Translate a website", "translate-page");
  if ("error" in paid) return { error: paid.error };
  const { found, credits } = paid;
  if (!Object.keys(found).length) return { error: "failed" };
  const host = new URL(page.url).hostname;
  const html = framedPage(translatePage(page.html, found, to), page.url, {
    said: t("Translated into {language} by Flash.", { language: to.label }),
    original: t("See the original on {site}", { site: host }),
  });
  const id = randomId(16);
  const title = found[page.title] ?? page.title;
  const at = now();
  await run("DELETE FROM page_translations WHERE created_at < ?", [at - KEEP_MS]);
  await run("INSERT INTO page_translations (id, user_id, url, lang, title, html, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, user.id, page.url, to.id, title, html, at]);
  return { id, url: page.url, title, lang: to.id, credits, missing: missingPhrases(page.phrases, found).length };
}

/** A kept translation's page, by its link's id; null once it's gone. */
export async function translatedPage(id: string): Promise<string | null> {
  if (!/^[\w-]{8,40}$/.test(id)) return null;
  const row = await one<{ html: string }>("SELECT html FROM page_translations WHERE id = ? AND created_at > ?", [id, now() - KEEP_MS]);
  return row?.html ?? null;
}

/** The user's recent translations, newest first. */
export const recentPages = (userId: string) =>
  all<{ id: string; url: string; title: string; lang: string; created_at: number }>(
    "SELECT id, url, title, lang, created_at FROM page_translations WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 10",
    [userId, now() - KEEP_MS],
  );
