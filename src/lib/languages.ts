/*
 * The language Flash answers in (Settings > General). "" is Automatic: Flash answers in the
 * language the user writes in, as it always has. Only the languages listed here are ever saved.
 * Flash's own buttons and menus are shown in it too (see i18n.ts).
 */
import type { Engine } from "./types.ts";

export type Language = {
  // What the account saves: a language tag.
  id: string;
  // How Settings shows it: its own name, with the English name after it where that helps.
  label: string;
  // The English name, for Flash's instructions.
  name: string;
  // What the browser listens and speaks in during a voice conversation; "" when browsers can't.
  speech: string;
};

// How Settings shows Automatic, which is saved as "".
export const AUTOMATIC_LANGUAGE = "Automatic (the language you write in)";

export const LANGUAGES: readonly Language[] = [
  { id: "en", label: "English", name: "English", speech: "en-US" },
  { id: "fr", label: "Français (French)", name: "French", speech: "fr-FR" },
  { id: "es", label: "Español (Spanish)", name: "Spanish", speech: "es-ES" },
  { id: "pt", label: "Português (Portuguese)", name: "Portuguese", speech: "pt-BR" },
  { id: "de", label: "Deutsch (German)", name: "German", speech: "de-DE" },
  { id: "it", label: "Italiano (Italian)", name: "Italian", speech: "it-IT" },
  { id: "nl", label: "Nederlands (Dutch)", name: "Dutch", speech: "nl-NL" },
  { id: "pl", label: "Polski (Polish)", name: "Polish", speech: "pl-PL" },
  { id: "tr", label: "Türkçe (Turkish)", name: "Turkish", speech: "tr-TR" },
  { id: "ru", label: "Русский (Russian)", name: "Russian", speech: "ru-RU" },
  { id: "uk", label: "Українська (Ukrainian)", name: "Ukrainian", speech: "uk-UA" },
  { id: "ar", label: "العربية (Arabic)", name: "Arabic", speech: "ar-SA" },
  { id: "he", label: "עברית (Hebrew)", name: "Hebrew", speech: "he-IL" },
  { id: "fa", label: "فارسی (Persian)", name: "Persian", speech: "fa-IR" },
  { id: "hi", label: "हिन्दी (Hindi)", name: "Hindi", speech: "hi-IN" },
  { id: "bn", label: "বাংলা (Bengali)", name: "Bengali", speech: "bn-BD" },
  { id: "ur", label: "اردو (Urdu)", name: "Urdu", speech: "ur-PK" },
  { id: "zh-Hans", label: "中文简体 (Chinese, Simplified)", name: "Simplified Chinese", speech: "zh-CN" },
  { id: "zh-Hant", label: "中文繁體 (Chinese, Traditional)", name: "Traditional Chinese", speech: "zh-TW" },
  { id: "ja", label: "日本語 (Japanese)", name: "Japanese", speech: "ja-JP" },
  { id: "ko", label: "한국어 (Korean)", name: "Korean", speech: "ko-KR" },
  { id: "id", label: "Bahasa Indonesia", name: "Indonesian", speech: "id-ID" },
  { id: "vi", label: "Tiếng Việt (Vietnamese)", name: "Vietnamese", speech: "vi-VN" },
  { id: "th", label: "ไทย (Thai)", name: "Thai", speech: "th-TH" },
  { id: "sw", label: "Kiswahili (Swahili)", name: "Swahili", speech: "sw-KE" },
  { id: "tl", label: "Tagalog", name: "Tagalog", speech: "fil-PH" },
  { id: "el", label: "Ελληνικά (Greek)", name: "Greek", speech: "el-GR" },
  { id: "sv", label: "Svenska (Swedish)", name: "Swedish", speech: "sv-SE" },
  { id: "ro", label: "Română (Romanian)", name: "Romanian", speech: "ro-RO" },
  // Browsers can't hear or speak Haitian Creole yet, so voice conversations stay as they are.
  { id: "ht", label: "Kreyòl ayisyen (Haitian Creole)", name: "Haitian Creole", speech: "" },
];

/** The listed language with this id, or null (Automatic, or anything not on the list). */
export const languageById = (id: unknown): Language | null => LANGUAGES.find((l) => l.id === id) ?? null;

/** Whether a value may be saved as the user's language: "" (Automatic) or a listed id. */
export const isLanguage = (value: unknown): value is string => value === "" || languageById(value) !== null;

/**
 * The sentence for Flash's instructions, or "" for Automatic. Builders also write the apps they
 * make in the language, and the translator only uses it when the user names no target language.
 */
export function languageNote(id: unknown, engine: Engine = "text"): string {
  const lang = languageById(id);
  if (!lang) return "";
  const { name } = lang;
  if (engine === "translate") {
    return (
      `If the user doesn't say which language to translate into, translate into ${name}` +
      (name === "English" ? "" : ` (or into English when the text is already in ${name})`) +
      `, and write any notes in ${name}. A language the user names in their message always comes first.`
    );
  }
  const answer = `Always answer in ${name}, even when the user writes in another language, unless they ask for a different language in their message.`;
  if (engine !== "app" && engine !== "slides") return answer;
  return (
    `${answer} Write the words in the apps, websites and slides you make in ${name} too, with lang="${lang.id}" on the <html> tag; ` +
    "when changing one, keep the language it already has unless the user asks to switch."
  );
}

/** For the picture and video prompt writer: words shown in a picture are in the user's language. */
export function pictureWordsNote(id: unknown): string {
  const lang = languageById(id);
  return lang ? `Any words shown in the picture or video (on a sign, poster, menu or label) are in ${lang.name}, unless the user gives the exact words.` : "";
}

const base = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];

/**
 * What a voice conversation listens and speaks in: the browser's own variant when it is the same
 * language (fr-CA, en-GB, pt-PT), else the language's usual one. "" keeps the browser's language,
 * for Automatic and for languages browsers can't hear.
 */
export function speechLang(id: unknown, browser = ""): string {
  const lang = languageById(id);
  if (!lang?.speech) return "";
  // Chinese is chosen by script, which the browser's region doesn't always match.
  if (browser && !lang.id.includes("-") && base(browser) === lang.id) return browser;
  return lang.speech;
}

/**
 * A voice that speaks tag: the one picked in Settings when it does, else one for the same
 * language and region, else for the same language. null leaves it to the browser.
 */
export function voiceFor<V extends { lang: string }>(voices: readonly V[], tag: string, picked: V | null = null): V | null {
  if (!tag) return picked;
  const want = tag.toLowerCase().replace(/_/g, "-");
  const same = (v: V) => base(v.lang) === base(want);
  if (picked && same(picked)) return picked;
  return voices.find((v) => v.lang.toLowerCase().replace(/_/g, "-") === want) ?? voices.find(same) ?? null;
}
