/*
 * Who may read, add, change and delete the shared records of a published app (window.flashDB).
 * Each collection has one of five rules, which the server checks on every request, so they hold
 * even when someone skips the app's own buttons. The app can name its rules in its page, the
 * owner can choose them in Flash, and apps made before rules existed get a guess from their code.
 * Pure, with no server imports: the server, My websites & apps and the tests all use it.
 */
import { english, msg, type Translate } from "./i18n.ts";

export const COLLECTION = /^[A-Za-z0-9_-]{1,40}$/;
export const DATA_RULES = ["read", "add", "own", "private", "open"] as const;
export type DataRule = (typeof DATA_RULES)[number];
export const isDataRule = (v: unknown): v is DataRule => typeof v === "string" && (DATA_RULES as readonly string[]).includes(v);

/** Who is asking: anyone at all, someone signed in to the app, or the app's owner. */
export type Caller = { kind: "anyone" } | { kind: "visitor"; id: string } | { kind: "owner" };
export const ANYONE: Caller = { kind: "anyone" };
export const OWNER: Caller = { kind: "owner" };

/** change means updating or deleting a record. */
export type DataAction = "read" | "add" | "change";
/** What Flash read from the app's page: its own rules, and the rule for everything else. */
export type ComputedRules = { v: 1; guess: DataRule; app: Record<string, DataRule> };
export type RuleSource = "you" | "app" | "default" | "guess";

export const MAX_DECLARED = 50;
export const MAX_BLOCK_CHARS = 4096;
// The owner's rule for every collection that has no rule of its own.
export const DEFAULT_KEY = "*";

/** Whether the caller may do this. author is the signed-in person who added the record, or "". */
export function can(rule: DataRule, action: DataAction, caller: Caller, author = ""): boolean {
  if (caller.kind === "owner") return true;
  const isAuthor = caller.kind === "visitor" && author !== "" && author === caller.id;
  switch (rule) {
    case "open":
      return true;
    case "add":
      return action !== "change" || isAuthor;
    case "own":
      return action === "read" || (action === "add" ? caller.kind === "visitor" : isAuthor);
    case "read":
      return action === "read";
    case "private":
      return action === "add";
  }
}

/** The answer when can() says no, in words an app can show. */
export function refusal(rule: DataRule, action: DataAction, caller: Caller): { status: number; error: string } {
  if (rule === "own" && action === "add" && caller.kind !== "visitor") return { status: 401, error: "Sign in to add here." };
  if (rule === "private" && action === "read") return { status: 403, error: "Only this app's owner can see this." };
  if (action === "change" && (rule === "add" || rule === "own")) return { status: 403, error: "You can only change or delete what you added." };
  return { status: 403, error: "Only this app's owner can change this." };
}

/**
 * A rule for an app made before rules existed, from what its code does with flashDB: an app that
 * changes or deletes shared records keeps working ("open"), one that only adds can't be wiped any
 * more ("add"), and one that only reads is read-only. Anything it can't follow counts as "open".
 */
export function guessRule(html: string): DataRule {
  // Each person's own records (flashDB.mine) have nothing to do with the shared ones.
  const code = html.replace(/\bflashDB\s*\??\.\s*mine\s*\??\./g, "");
  if (!/\bflashDB\b/.test(code)) return "read";
  // flashDB passed around, read with brackets or tested with typeof: what it does can't be followed.
  if (/\bflashDB\b(?!\s*\??\.\s*[A-Za-z_$])/.test(code)) return "open";
  if (/\bflashDB\s*\??\.\s*(update|remove)\b/.test(code)) return "open";
  if (/\bflashDB\s*\??\.\s*add\b/.test(code)) return "add";
  return "read";
}

/** The first <script type="application/json" id="flash-data"> block's object, or null when there is none to use. */
function dataBlock(html: string): Record<string, unknown> | null {
  // Each tag is read only up to its first 300 characters, so a page of any shape is read quickly.
  for (const tag of html.matchAll(/<script\b([^<>]{0,300})>/gi)) {
    if (!/(?:^|\s)id\s*=\s*(["']?)flash-data\1(?:\s|\/|$)/i.test(tag[1])) continue;
    const start = tag.index! + tag[0].length;
    const close = /<\/script/gi;
    close.lastIndex = start;
    const end = close.exec(html)?.index ?? -1;
    if (end === -1 || end - start > MAX_BLOCK_CHARS) return null;
    try {
      const value = JSON.parse(html.slice(start, end));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The rules the app names for its collections, like {"menu":"read","reviews":"add"}. Anything odd is left out. */
export function declaredRules(html: string): Record<string, DataRule> {
  return validRules(dataBlock(html) ?? {}, MAX_DECLARED);
}

/** Only real collection names with real rules. fromEntries, so even a collection called __proto__ is just a name. */
function validRules(value: object, max = Infinity): Record<string, DataRule> {
  const entries = Object.entries(value).filter((e): e is [string, DataRule] => COLLECTION.test(e[0]) && isDataRule(e[1]));
  return Object.fromEntries(entries.slice(0, max));
}

/** What Flash keeps about an app's page. An app that names its rules is strict about collections it didn't name. */
export function computeRules(html: string): ComputedRules {
  return { v: 1, guess: dataBlock(html) ? "read" : guessRule(html), app: declaredRules(html) };
}

/** Rules saved by computeRules, or null when they are missing or damaged (they are worked out again then). */
export function parseComputed(text: string | null | undefined): ComputedRules | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (value?.v !== 1 || !isDataRule(value.guess) || !value.app || typeof value.app !== "object" || Array.isArray(value.app)) return null;
    return { v: 1, guess: value.guess, app: validRules(value.app) };
  } catch {
    return null;
  }
}

/** The rule that applies: the owner's choice, then the app's, then the owner's default, then the guess. */
export function effectiveRule(
  computed: ComputedRules,
  chosen: string | null | undefined,
  fallback: string | null | undefined,
  collection: string,
): { rule: DataRule; source: RuleSource } {
  if (isDataRule(chosen)) return { rule: chosen, source: "you" };
  const declared = Object.hasOwn(computed.app, collection) ? computed.app[collection] : undefined;
  if (declared) return { rule: declared, source: "app" };
  if (isDataRule(fallback)) return { rule: fallback, source: "default" };
  return { rule: computed.guess, source: "guess" };
}

/** Whether anyone at all could change or delete some of the app's data. chosen holds the owner's rules, "*" included. */
export function anyOpen(computed: ComputedRules, chosen: Record<string, DataRule>): boolean {
  const names = new Set([...Object.keys(computed.app), ...Object.keys(chosen)].filter((n) => n !== DEFAULT_KEY));
  for (const name of names) if (effectiveRule(computed, chosen[name], chosen[DEFAULT_KEY], name).rule === "open") return true;
  return (chosen[DEFAULT_KEY] ?? computed.guess) === "open";
}

// Words for the owner, in Flash: translated where they're shown, with t().
export const RULE_TEXT: Record<DataRule, { label: string; help: string }> = {
  read: { label: msg("Only you can add or change it"), help: msg("Visitors see it. Good for menus, products, posts and prices.") },
  add: {
    label: msg("Visitors can add"),
    help: msg(
      "Anyone can add. Only you, or the signed-in person who added a record, can change or delete it. Good for reviews, comments and scores.",
    ),
  },
  own: {
    label: msg("Signed-in people manage their own"),
    help: msg("Visitors see it. People signed in to your app can add, and change or delete what they added."),
  },
  private: { label: msg("Only you can see it"), help: msg("Visitors can add, but only you can read it. Good for sign-ups and requests.") },
  open: {
    label: msg("Anyone can change anything"),
    help: msg("Anyone can add, change or delete every record, even without your app's buttons. Use only for a list a group edits together."),
  },
};

/** One-line summaries, for the line shown after publishing. */
export const RULE_SHORT: Record<DataRule, string> = {
  read: msg("only you"),
  add: msg("visitors can add"),
  own: msg("signed-in people manage their own"),
  private: msg("only you can see it"),
  open: msg("anyone can change anything"),
};

/** What publishing reports about the app's data: each named collection's rule, and the rule for anything else. */
export type DataSummary = { collections: { name: string; rule: DataRule; source: RuleSource }[]; other: DataRule };

/**
 * "Who can change this app's data: menu — only you · reviews — visitors can add · anything else — only you. …"
 * Empty for an app that keeps no shared data of its own, like a plain website. t words it for the owner.
 */
export function dataLine(data: DataSummary, shown = 8, t: Translate = english): string {
  if (!data.collections.length && data.other === "read") return "";
  const parts = data.collections.slice(0, shown).map((c) => t("{collection} — {rule}", { collection: c.name, rule: t(RULE_SHORT[c.rule]) }));
  if (data.collections.length > shown) parts.push(t("{count} more", { count: data.collections.length - shown }));
  parts.push(t("anything else — {rule}", { rule: t(RULE_SHORT[data.other]) }));
  return t("Who can change this app's data: {rules}. Change it in My websites & apps › Data.", { rules: parts.join(" · ") });
}

// Field names that usually hold personal details. Short ones must be a whole word, so "hotel" isn't a phone.
const PERSONAL_PART = /e-?mail|phone|mobile|address|postcode|birth|password/i;
const PERSONAL_WORD = new Set(["tel", "zip", "dob", "card", "iban"]);

/** The field names that look like personal details (email, userEmail, phone_number, Address, dob…). */
export function looksPersonal(keys: string[]): string[] {
  return keys.filter((key) => {
    if (PERSONAL_PART.test(key)) return true;
    const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
    return words.some((w) => PERSONAL_WORD.has(w));
  });
}
