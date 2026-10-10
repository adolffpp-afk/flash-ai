/*
 * Where each language's table is (see i18n.ts). Each is its own file, loaded only when someone is
 * shown Flash in that language: in the browser by use-t.ts, on the server by server/i18n.ts.
 * English has none: it's the source.
 */
import type { Table } from "./i18n.ts";

export const TABLES: Record<string, () => Promise<{ default: Table }>> = {
  fr: () => import("./i18n/fr.json"),
  es: () => import("./i18n/es.json"),
  pt: () => import("./i18n/pt.json"),
  de: () => import("./i18n/de.json"),
  it: () => import("./i18n/it.json"),
  nl: () => import("./i18n/nl.json"),
  pl: () => import("./i18n/pl.json"),
  tr: () => import("./i18n/tr.json"),
  ru: () => import("./i18n/ru.json"),
  uk: () => import("./i18n/uk.json"),
  ar: () => import("./i18n/ar.json"),
  he: () => import("./i18n/he.json"),
  fa: () => import("./i18n/fa.json"),
  hi: () => import("./i18n/hi.json"),
  bn: () => import("./i18n/bn.json"),
  ur: () => import("./i18n/ur.json"),
  "zh-Hans": () => import("./i18n/zh-Hans.json"),
  "zh-Hant": () => import("./i18n/zh-Hant.json"),
  ja: () => import("./i18n/ja.json"),
  ko: () => import("./i18n/ko.json"),
  id: () => import("./i18n/id.json"),
  vi: () => import("./i18n/vi.json"),
  th: () => import("./i18n/th.json"),
  sw: () => import("./i18n/sw.json"),
  tl: () => import("./i18n/tl.json"),
  el: () => import("./i18n/el.json"),
  sv: () => import("./i18n/sv.json"),
  ro: () => import("./i18n/ro.json"),
  ht: () => import("./i18n/ht.json"),
};
