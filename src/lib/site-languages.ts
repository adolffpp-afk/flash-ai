/*
 * The languages an app built with Flash can be translated into (Translate my app, see
 * site-translate.ts): every language Flash itself is shown in, and more that visitors read, African
 * languages first among them. Each is named in its own words, as a visitor looks for it on the app's
 * language button, with the English name after it for the owner where that helps.
 */
import { LANGUAGES } from "./languages.ts";

export type SiteLanguage = {
  id: string;
  // How the owner sees it in Flash: its own name, with the English name after it where that helps.
  label: string;
  // How the app's language button shows it to visitors: its own name only.
  own: string;
  // The English name, for the translator's instructions.
  name: string;
  rtl?: boolean;
};

/** "Français (French)" → "Français": a language's own name, as visitors see it. */
const ownName = (label: string) => label.replace(/\s*\([^)]*\)\s*$/, "");

// Languages visitors read that Flash isn't shown in (yet). One Flash adds to Settings later is
// taken from LANGUAGES instead, by its id.
const MORE: readonly SiteLanguage[] = [
  { id: "zu", label: "isiZulu (Zulu)", own: "isiZulu", name: "Zulu" },
  { id: "xh", label: "isiXhosa (Xhosa)", own: "isiXhosa", name: "Xhosa" },
  { id: "af", label: "Afrikaans", own: "Afrikaans", name: "Afrikaans" },
  { id: "ha", label: "Hausa", own: "Hausa", name: "Hausa" },
  { id: "yo", label: "Yorùbá (Yoruba)", own: "Yorùbá", name: "Yoruba" },
  { id: "ig", label: "Asụsụ Igbo (Igbo)", own: "Asụsụ Igbo", name: "Igbo" },
  { id: "am", label: "አማርኛ (Amharic)", own: "አማርኛ", name: "Amharic" },
  { id: "so", label: "Soomaali (Somali)", own: "Soomaali", name: "Somali" },
  { id: "rw", label: "Ikinyarwanda (Kinyarwanda)", own: "Ikinyarwanda", name: "Kinyarwanda" },
  { id: "ln", label: "Lingála (Lingala)", own: "Lingála", name: "Lingala" },
  { id: "wo", label: "Wolof", own: "Wolof", name: "Wolof" },
];

// Shown first among the languages to add, as the owner asked: the languages of Africa.
export const AFRICAN = new Set(["sw", "zu", "xh", "af", "ha", "yo", "ig", "am", "so", "rw", "ln", "wo"]);

export const SITE_LANGUAGES: readonly SiteLanguage[] = [
  ...LANGUAGES.map((l) => ({ id: l.id, label: l.label, own: ownName(l.label), name: l.name, ...(l.rtl && { rtl: true }) })),
  ...MORE.filter((m) => !LANGUAGES.some((l) => l.id === m.id)),
];

/** The language an app can be translated into with this id, or null. */
export const siteLanguage = (id: unknown): SiteLanguage | null => SITE_LANGUAGES.find((l) => l.id === id) ?? null;

/**
 * The listed language a tag is (fr-CA → fr, zh-TW → zh-Hant, fil → tl), or null. For an app's own
 * lang="…" and the languages a visitor's browser asks for.
 */
export function siteLanguageOf(tag: string): SiteLanguage | null {
  const lower = tag.trim().toLowerCase().replace(/_/g, "-");
  const base = lower.split("-")[0];
  if (base === "zh") return siteLanguage(/-(hant|tw|hk|mo)\b/.test(lower) ? "zh-Hant" : "zh-Hans");
  if (base === "fil") return siteLanguage("tl");
  if (base === "iw") return siteLanguage("he");
  return siteLanguage(base);
}
