/*
 * Flash's own words in the browser: useT() gives components t("…") in the language Flash is shown
 * in (see i18n.ts), and showLanguage() switches it when the account loads or the setting changes.
 * Every component on screen redraws in the new language at once, Settings included.
 */
import { Fragment, createElement, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { localeOf, translate, uiLanguage, type Blanks, type Table, type Translate } from "./i18n.ts";
import { TABLES } from "./i18n-tables.ts";

type Shown = { language: string; table: Table | null };

const ENGLISH: Shown = { language: "en", table: null };
let shown = ENGLISH;
const listeners = new Set<() => void>();
const loaded = new Map<string, Table>();
// Only the latest switch counts, when a slower table arrives after a newer pick.
let latest = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Shows Flash in the language saved in Settings ("" is Automatic: the browser's language when Flash
 * has it). Resolves once its table is loaded, so the first screen is already in it. A table that
 * can't load (offline) leaves Flash in English.
 */
export async function showLanguage(saved: unknown): Promise<void> {
  const language = uiLanguage(saved, typeof navigator === "undefined" ? [] : navigator.languages);
  const turn = ++latest;
  let table = loaded.get(language) ?? null;
  if (!table && TABLES[language]) {
    try {
      table = (await TABLES[language]()).default;
      loaded.set(language, table);
    } catch {
      table = null;
    }
  }
  if (turn !== latest) return;
  const next: Shown = table ? { language, table } : ENGLISH;
  if (next.language === shown.language && next.table === shown.table) return;
  shown = next;
  // Screen readers, spell checkers and fonts follow the page's language. The layout stays left to right.
  if (typeof document !== "undefined") document.documentElement.lang = next.language;
  for (const listener of listeners) listener();
}

export type T = Translate & {
  // The language Flash is shown in, and the locale its dates and numbers use.
  language: string;
  locale: string;
  /** A phrase with parts that aren't plain text (a link, bold words): t.node("Read the {terms}", { terms: <a>…</a> }). */
  node: (text: string, parts: Record<string, ReactNode>) => ReactNode;
};

function translator({ language, table }: Shown): T {
  const t: Translate = (text, blanks?: Blanks) => translate(table, text, blanks);
  const node = (text: string, parts: Record<string, ReactNode>): ReactNode => {
    const pieces = translate(table, text).split(/\{(\w+)\}/);
    // split puts the blanks' names at the odd places.
    return createElement(Fragment, null, ...pieces.map((piece, i) => (i % 2 ? (piece in parts ? parts[piece] : `{${piece}}`) : piece)));
  };
  return Object.assign(t, { language, locale: localeOf(language), node });
}

const englishT = translator(ENGLISH);

/** t("…") for a component, in the language Flash is shown in. The server and the first render use English. */
export function useT(): T {
  const now = useSyncExternalStore(subscribe, () => shown, () => ENGLISH);
  return useMemo(() => (now === ENGLISH ? englishT : translator(now)), [now]);
}

/** t for code that runs outside a render, like a notification or a confirmation, in the language shown now. */
export const tNow: Translate = (text, blanks) => translate(shown.table, text, blanks);
