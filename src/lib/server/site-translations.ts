import Anthropic from "@anthropic-ai/sdk";
import { all, one, run, now } from "./db.ts";
import { isAdmin, type User } from "./auth.ts";
import { acceptLanguages } from "./i18n.ts";
import { charge, ensureMonthlyCredits, logUsage, settle, spendable } from "./credits.ts";
import { claudeConfigured, getClient, meterClaude, meterLost, type Meter } from "../engines/claude.ts";
import { creditsFor } from "../credits.ts";
import { injectHead } from "../flashdb-shim.ts";
import { SITE_LANGUAGES, siteLanguage, siteLanguageOf, type SiteLanguage } from "../site-languages.ts";
import {
  TRANSLATE_MODEL,
  LANG_PARAM,
  chunkMaxCents,
  chunkMaxTokens,
  chunksOf,
  missingPhrases,
  pageLanguage,
  pagePhrases,
  pickLanguage,
  readTranslations,
  translateCredits,
  translatePage,
  translateScript,
  translatorMessage,
  translatorSystem,
  type Phrasebook,
} from "../site-translate.ts";

/*
 * Translate my app (see site-translate.ts): each language an app is shown in is one row, with its
 * phrasebook, the page's phrases and their translations. The owner tries it first: admins only, until
 * FLASH_TRANSLATE_OPEN is "true" in Vercel.
 */
export const translateOpen = () => process.env.FLASH_TRANSLATE_OPEN === "true";
export const translateOpenTo = (user: Pick<User, "email" | "verified_at">): boolean => translateOpen() || isAdmin(user);

// The most an app is shown in, besides its own language.
export const MAX_SITE_LANGUAGES = 40;
// Calls for one language that run side by side.
const PARALLEL = 4;
const CALL_MS = 150_000;

/** A site's own language: the one its page names, else English. */
export const sourceOf = (html: string): SiteLanguage => siteLanguageOf(pageLanguage(html)) ?? siteLanguage("en")!;

const parseBook = (text: string | null | undefined): Record<string, string> => {
  try {
    const book = JSON.parse(text || "{}") as unknown;
    return book && typeof book === "object" && !Array.isArray(book) ? (book as Record<string, string>) : {};
  } catch {
    return {};
  }
};

/** The languages a site is shown in, each with its phrasebook. */
async function books(slug: string): Promise<{ lang: string; book: Record<string, string>; updated_at: number }[]> {
  const rows = await all<{ lang: string; phrases: string; updated_at: number }>(
    "SELECT lang, phrases, updated_at FROM site_translations WHERE site_slug = ? ORDER BY created_at",
    [slug],
  );
  return rows.map((r) => ({ lang: r.lang, book: parseBook(r.phrases), updated_at: Number(r.updated_at) }));
}

export type LanguageStatus = { id: string; label: string; own: string; name: string; total: number; missing: number; most: number; typical: number; updatedAt: number };
export type TranslationsView = {
  source: { id: string; label: string };
  phrases: number;
  // What a new language costs: the whole page's phrases.
  most: number;
  typical: number;
  languages: LanguageStatus[];
  // Every language the app may be translated into, for the owner's list.
  choices: { id: string; label: string; own: string; name: string }[];
  max: number;
};

/** What the Languages view shows for one of the owner's sites; null when it isn't theirs. */
export async function translationsView(userId: string, slug: string): Promise<TranslationsView | null> {
  const site = await one<{ html: string }>("SELECT html FROM sites WHERE slug = ? AND user_id = ?", [slug, userId]);
  if (!site) return null;
  const source = sourceOf(site.html);
  const phrases = pagePhrases(site.html);
  const languages = (await books(slug)).flatMap(({ lang, book, updated_at }) => {
    const l = siteLanguage(lang);
    if (!l) return [];
    const missing = missingPhrases(phrases, book);
    return [{ id: l.id, label: l.label, own: l.own, name: l.name, total: phrases.length, missing: missing.length, ...translateCredits(missing, l.id), updatedAt: updated_at }];
  });
  return {
    source: { id: source.id, label: source.label },
    phrases: phrases.length,
    // At the dearest language's, as scripts other than Latin write more tokens: the most any language can cost.
    most: translateCredits(phrases, "am").most,
    typical: translateCredits(phrases, "am").typical,
    languages,
    choices: SITE_LANGUAGES.filter((l) => l.id !== source.id).map((l) => ({ id: l.id, label: l.label, own: l.own, name: l.name })),
    max: MAX_SITE_LANGUAGES,
  };
}

/** Translates one chunk, metered at what it cost (or, when it may have run and failed, at the most it could). */
async function translateChunk(chunk: string[], from: SiteLanguage | null, to: SiteLanguage, title: string, meter: Meter): Promise<Record<string, string>> {
  const res = await getClient()
    .beta.messages.create(
      {
        model: TRANSLATE_MODEL,
        max_tokens: chunkMaxTokens(chunk, to.id),
        output_config: { effort: "low" },
        system: translatorSystem(from, to, title),
        messages: [{ role: "user", content: translatorMessage(chunk) }],
      },
      { timeout: CALL_MS, maxRetries: 0, signal: AbortSignal.timeout(CALL_MS) },
    )
    .catch((err: unknown) => meterLost(err, meter, chunkMaxCents(chunk, to.id), TRANSLATE_MODEL));
  meterClaude(meter, res, TRANSLATE_MODEL);
  if (res.stop_reason === "refusal") return {};
  const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  return readTranslations(text, chunk);
}

export type TranslateResult =
  | { ok: true; lang: string; credits: number; translated: number; missing: number; total: number }
  | { error: "not_found" | "language" | "same" | "too_many" | "unavailable" | "credits" | "failed"; credits?: number };

/**
 * Translates what a site's page shows into a language, adding the language if it's new: only the
 * phrases its book lacks. Held at the most it can cost before any call, settled at what it cost.
 */
export async function translateSite(user: User, slug: string, langId: unknown): Promise<TranslateResult> {
  const site = await one<{ html: string; title: string }>("SELECT html, title FROM sites WHERE slug = ? AND user_id = ?", [slug, user.id]);
  if (!site) return { error: "not_found" };
  const to = siteLanguage(langId);
  if (!to) return { error: "language" };
  const source = sourceOf(site.html);
  if (to.id === source.id) return { error: "same" };
  const existing = await books(slug);
  const had = existing.find((b) => b.lang === to.id);
  if (!had && existing.length >= MAX_SITE_LANGUAGES) return { error: "too_many" };
  const phrases = pagePhrases(site.html);
  const missing = missingPhrases(phrases, had?.book ?? {});
  const save = async (found: Record<string, string>) => {
    // Only the page's phrases are kept, so a book never holds what the app no longer shows.
    const keep = new Set(phrases);
    const book = Object.fromEntries(Object.entries({ ...(had?.book ?? {}), ...found }).filter(([k]) => keep.has(k)));
    const t = now();
    await run(
      `INSERT INTO site_translations (site_slug, lang, phrases, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(site_slug, lang) DO UPDATE SET phrases = excluded.phrases, updated_at = excluded.updated_at`,
      [slug, to.id, JSON.stringify(book), t, t],
    );
    return Object.keys(book).length;
  };
  if (!missing.length) {
    const translated = await save({});
    return { ok: true, lang: to.id, credits: 0, translated, missing: 0, total: phrases.length };
  }
  if (!claudeConfigured()) return { error: "unavailable" };

  const chunks = chunksOf(missing);
  const held = creditsFor(chunks.reduce((n, c) => n + chunkMaxCents(c, to.id), 0));
  await ensureMonthlyCredits(user.id);
  const { largest } = await spendable(user.id);
  if (largest < held) return { error: "credits" };
  const chargeId = await charge(user.id, held, "Translate my app");
  if (chargeId === null) return { error: "credits" };

  const spend: number[] = [];
  const meter: Meter = (_provider, _model, cents) => spend.push(cents);
  const found: Record<string, string> = {};
  const from = pageLanguage(site.html) ? source : null;
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        try {
          Object.assign(found, await translateChunk(chunk, from, to, site.title, meter));
        } catch (err) {
          failed++;
          console.error("[flash] translate chunk failed", err);
        }
      }
    }),
  );
  const costCents = spend.reduce((n, c) => n + c, 0);
  const credits = costCents <= 0 ? 0 : Math.min(held, creditsFor(costCents));
  await settle(chargeId, credits);
  await logUsage({ userId: user.id, engine: "translate-app", model: TRANSLATE_MODEL, provider: "anthropic", credits, costCents, ok: failed < chunks.length }).catch((err) =>
    console.error("[flash] usage log failed", err),
  );
  if (!Object.keys(found).length && !had) return { error: "failed", credits };
  const translated = await save(found);
  return { ok: true, lang: to.id, credits, translated, missing: missingPhrases(phrases, { ...(had?.book ?? {}), ...found }).length, total: phrases.length };
}

/** Stops showing a site in a language. False when the site isn't the user's. */
export async function removeLanguage(userId: string, slug: string, lang: string): Promise<boolean> {
  const owned = await one("SELECT 1 FROM sites WHERE slug = ? AND user_id = ?", [slug, userId]);
  if (!owned) return false;
  await run("DELETE FROM site_translations WHERE site_slug = ? AND lang = ?", [slug, lang]);
  return true;
}

export type ShownLanguage = {
  // The page in the language shown, with its script, and the language's tag (null: as written).
  html: string;
  lang: string | null;
  // Whether the page's address asked for it, so the address search engines list it under carries it too.
  asked: boolean;
  // Links to the page in each language, for search engines, by the language's tag ("x-default" too).
  alternates: { hreflang: string; href: string }[];
};

/**
 * A published page in the language a visit asks for (?lang=…), else its browser's, with the language
 * button. A site in no other language is returned as it is.
 */
export async function inVisitorLanguage(slug: string, html: string, request: Request | undefined, label: (lang: string) => Promise<string>, canonical?: string): Promise<ShownLanguage> {
  const rows = await all<{ lang: string; phrases: string }>(
    "SELECT lang, phrases FROM site_translations WHERE site_slug = ? ORDER BY created_at",
    [slug],
  );
  const offered = rows.map((r) => siteLanguage(r.lang)).filter((l): l is SiteLanguage => l !== null);
  if (!offered.length) return { html, lang: null, asked: false, alternates: [] };
  const source = sourceOf(html);
  const url = request ? new URL(request.url) : null;
  const param = url?.searchParams.get(LANG_PARAM) ?? null;
  const shown = pickLanguage(
    param,
    acceptLanguages(request?.headers.get("accept-language")),
    offered.map((l) => l.id),
    source.id,
    siteLanguageOf,
  );
  const lang = shown ? siteLanguage(shown)! : null;
  const book: Phrasebook = lang ? parseBook(rows.find((r) => r.lang === lang.id)?.phrases) : {};
  const choices = [source, ...offered].map((l) => ({ id: l.id, own: l.own }));
  const page = lang ? translatePage(html, book, lang) : html;
  const alternates = canonical
    ? [
        { hreflang: source.id, href: `${canonical}?${LANG_PARAM}=${source.id}` },
        ...offered.map((l) => ({ hreflang: l.id, href: `${canonical}?${LANG_PARAM}=${l.id}` })),
        { hreflang: "x-default", href: canonical },
      ]
    : [];
  const script = translateScript(book, lang?.id ?? source.id, choices, await label(lang?.id ?? source.id));
  // First in the head, so the words the app's own scripts show are swapped as they appear.
  return { html: injectHead(page, script), lang: lang?.id ?? null, asked: Boolean(lang && param), alternates };
}
