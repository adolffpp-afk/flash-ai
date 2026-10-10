/*
 * Flash's own words (Home, menus, buttons, Settings, what a voice conversation says) in the
 * language picked in Settings > General. English is the source: each phrase is written in English
 * where it's shown, as t("…") (see use-t.ts), and that English is its key in each language's table,
 * src/lib/i18n/<id>.json. The tables are written once, checked in and shipped with the app, so they
 * cost Flash nothing when people use it and call no service. A phrase a table lacks shows in English.
 * The signed-out pages, the legal pages and the admin pages stay in English.
 *
 * Words that change go in blanks: t("{count} credits left", { count }). A phrase written outside a
 * component (a list of labels, a reason a function returns) is marked msg("…") where it's written,
 * so scripts/i18n-keys.ts finds it, and translated where it's shown: t(label).
 */
import { LANGUAGES, languageById } from "./languages.ts";

export type Blanks = Record<string, string | number>;
export type Table = Readonly<Record<string, string>>;
export type Translate = (text: string, blanks?: Blanks) => string;

/** Marks a phrase for the tables where it's written; it's translated where it's shown, with t(). */
export const msg = <T extends string>(text: T): T => text;

/** Fills in {name} blanks. A blank with no value stays as written. */
export function fill(text: string, blanks?: Blanks): string {
  if (!blanks) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in blanks ? String(blanks[name]) : all));
}

/** The phrase from the table, else the English, with its blanks filled in. */
export const translate = (table: Table | null, text: string, blanks?: Blanks): string => fill(table?.[text] || text, blanks);

/** Flash in English: each phrase as written. */
export const english: Translate = (text, blanks) => fill(text, blanks);

/** The listed language a browser language tag (fr-CA, zh-TW, fil) is, or null. */
function fromBrowser(tag: string): string | null {
  const lower = tag.toLowerCase().replace(/_/g, "-");
  const base = lower.split("-")[0];
  if (base === "zh") return /-(hant|tw|hk|mo)\b/.test(lower) ? "zh-Hant" : "zh-Hans";
  if (base === "fil") return "tl";
  if (base === "iw") return "he";
  return LANGUAGES.find((l) => l.id === base)?.id ?? null;
}

/**
 * The language Flash's own words are shown in: the one picked in Settings, else (Automatic) the
 * first of the browser's languages Flash has, else English.
 */
export function uiLanguage(saved: unknown, browser: readonly string[] = []): string {
  const picked = languageById(saved);
  if (picked) return picked.id;
  for (const tag of browser) {
    const id = fromBrowser(tag);
    if (id) return id;
  }
  return "en";
}

/**
 * The locale dates and numbers are written in. Browsers have no dates in Haitian Creole, so Haiti's
 * French ones are used. Saudi Arabic dates are Hijri by default, so Arabic asks for the Gregorian
 * calendar most Arabic speakers use day to day.
 */
export const localeOf = (id: string): string =>
  id === "ht" ? "fr-HT" : id === "ar" ? "ar-SA-u-ca-gregory" : languageById(id)?.speech || "en-US";
