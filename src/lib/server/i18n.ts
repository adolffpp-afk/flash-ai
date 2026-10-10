/*
 * Flash's own words in what the server sends back (errors, what a request is doing, why a level
 * was picked), in the language Flash is shown in (see i18n.ts): the one picked in Settings, else
 * the browser's, which every request carries in its Accept-Language header.
 * Pages Flash publishes for its users' visitors don't use this: their words are the site owner's.
 */
import { english, localeOf, translate, uiLanguage, type Table, type Translate } from "../i18n.ts";
import { TABLES } from "../i18n-tables.ts";

const loaded = new Map<string, Table>();

/** The languages an Accept-Language header asks for, most wanted first: "fr-CA,fr;q=0.9,en;q=0.8" gives fr-CA, fr, en. */
export function acceptLanguages(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.trim().slice(2) ?? 1);
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((l) => l.tag && l.tag !== "*" && l.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((l) => l.tag);
}

export type ServerT = Translate & { language: string; locale: string };

/** t in a language: its table, loaded once per server, else English. */
export async function translatorIn(language: string): Promise<ServerT> {
  let table = loaded.get(language) ?? null;
  if (!table && TABLES[language]) {
    try {
      table = (await TABLES[language]()).default;
      loaded.set(language, table);
    } catch {
      table = null;
    }
  }
  const t: Translate = table ? (text, blanks) => translate(table, text, blanks) : english;
  return Object.assign(t, { language: table ? language : "en", locale: localeOf(table ? language : "en") });
}

/** t for the reply to this request: the account's language (saved), else the browser's, else English. */
export async function translatorFor(request: Request, saved?: unknown): Promise<ServerT> {
  return translatorIn(uiLanguage(saved, acceptLanguages(request.headers.get("accept-language"))));
}
