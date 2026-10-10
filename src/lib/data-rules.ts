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

/**
 * Who is asking: anyone at all, someone signed in to the app, the app's owner in Flash (My websites
 * & apps › Data), or the owner in the app itself, with the owner key Flash put into the page when
 * they chose Open as owner (see site-owner.ts).
 */
export type Caller = { kind: "anyone" } | { kind: "visitor"; id: string } | { kind: "owner" } | { kind: "ownerInApp" };
export const ANYONE: Caller = { kind: "anyone" };
export const OWNER: Caller = { kind: "owner" };
export const OWNER_IN_APP: Caller = { kind: "ownerInApp" };

/** change means updating or deleting a record. */
export type DataAction = "read" | "add" | "change";
/** Why Flash couldn't use (part of) an app's flash-data block. */
export type BlockProblem = "long" | "unclosed" | "json" | "shape" | "entries";
/** What Flash read from the app's page: its own rules, and the rule for everything else. */
export type ComputedRules = {
  v: 1;
  // The rule for a collection the app doesn't name: its block's "*", read-only when the block has
  // none, or a guess from its code when it has no block.
  guess: DataRule;
  app: Record<string, DataRule>;
  // The page has a flash-data block.
  block?: true;
  // What Flash couldn't use in the block, with the names it couldn't use: those are read-only for
  // visitors, and so is everything when the block couldn't be read at all.
  bad?: { why: BlockProblem; names: string[] };
  // The guess is "open" only because the app, made before rules, keeps records that code Flash
  // can't see wrote (a script from elsewhere), so it keeps working until its page names its rules.
  fromRecords?: true;
  // The collections its code names in flashDB calls, so the owner sees them before they hold anything.
  code?: string[];
};
/** Where a collection's rule comes from: the owner, the app naming it, the owner's default, Flash's guess, or the app's block's rule for anything it doesn't name. */
export type RuleSource = "you" | "app" | "default" | "guess" | "block";

export const MAX_DECLARED = 50;
export const MAX_BLOCK_CHARS = 4096;
// The owner's rule, or the app's, for every collection that has no rule of its own.
export const DEFAULT_KEY = "*";

/** Whether the caller may do this. author is the signed-in person who added the record, or "". */
export function can(rule: DataRule, action: DataAction, caller: Caller, author = ""): boolean {
  if (caller.kind === "owner") return true;
  // In the app itself the owner can do anything but see or change a private collection: only
  // Flash shows those, so a script that gets into the page can't read the sign-ups.
  if (caller.kind === "ownerInApp") return rule !== "private" || action === "add";
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
  if (rule === "private" && caller.kind === "ownerInApp") return { status: 403, error: "You can see this in Flash, in My websites & apps › Data." };
  if (rule === "own" && action === "add" && caller.kind !== "visitor") return { status: 401, error: "Sign in to add here." };
  if (rule === "private" && action === "read") return { status: 403, error: "Only this app's owner can see this." };
  if (action === "change" && (rule === "add" || rule === "own")) return { status: 403, error: "You can only change or delete what you added." };
  return { status: 403, error: "Only this app's owner can change this." };
}

/**
 * A rule for an app with no flash-data block, from what its code does with flashDB. An app made
 * before rules existed that changes or deletes shared records keeps working ("open"), one that only
 * adds can't be wiped any more ("add"), and one that only reads is read-only. Anything it can't
 * follow counts as "open". An app that checks flashDB.isOwner was made after rules existed, so its
 * changes are the owner's: it gets "add" or "read".
 */
export function guessRule(html: string): DataRule {
  // Each person's own records (flashDB.mine) have nothing to do with the shared ones.
  const code = html.replace(/\bflashDB\s*\??\.\s*mine\s*\??\./g, "");
  if (!/\bflashDB\b/.test(code)) return "read";
  const adds = /\bflashDB\s*\??\.\s*add\b/.test(code);
  if (/\bflashDB\s*\??\.\s*isOwner\b/.test(code)) return adds ? "add" : "read";
  // flashDB passed around, read with brackets or tested with typeof: what it does can't be followed.
  if (/\bflashDB\b(?!\s*\??\.\s*[A-Za-z_$])/.test(code)) return "open";
  if (/\bflashDB\s*\??\.\s*(update|remove)\b/.test(code)) return "open";
  return adds ? "add" : "read";
}

/**
 * The shared collections the code names in flashDB.list, add, update and remove calls ("menu" in
 * flashDB.add("menu", …)), but not names made while it runs ("room-" + id).
 */
export function codeCollections(html: string): string[] {
  const names = new Set<string>();
  for (const m of html.matchAll(/\bflashDB\s*\??\.\s*(?:list|add|update|remove)\s*\(\s*(["'`])([A-Za-z0-9_-]{1,40})\1\s*[,)]/g)) {
    names.add(m[2]);
    if (names.size >= MAX_DECLARED) break;
  }
  return [...names];
}

/**
 * JSON with the slips people make by hand taken out first: comments (// to the end of the line,
 * or between slash-star and star-slash) and a comma just before } or ]. Strings are kept exactly as
 * written, so nothing inside one is touched.
 */
function looseJson(text: string): unknown {
  // Where the next thing that isn't a space or a comment starts.
  const next = (i: number): number => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end;
      } else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) throw new SyntaxError("A comment isn't closed.");
        i = end + 2;
      } else return i;
    }
  };
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      out += " ";
      i = next(i);
    } else {
      if (!(text[i] === "," && /^[}\]]$/.test(text[next(i + 1)] ?? ""))) out += text[i];
      i++;
    }
  }
  return JSON.parse(out);
}

type Block = { found: false } | { found: true; value: Record<string, unknown> } | { found: true; problem: Exclude<BlockProblem, "entries"> };

/**
 * Whether a script tagged id="flash-data" holds something other than rules: code (a src, or a type
 * other than JSON), or the app's own data that happens to use the id, like a list of cards or
 * {"cards":[…]}. Rules are words, so an object with no word in it isn't rules; an empty one is.
 */
const notRules = (attributes: string) => {
  const type = attributes.match(/(?:^|\s)type\s*=\s*["']?([^\s"'>]*)/i)?.[1];
  return /(?:^|\s)src\s*=/i.test(attributes) || (type !== undefined && type.split(";")[0].toLowerCase() !== "application/json");
};
const appsOwnData = (value: unknown) =>
  Array.isArray(value) || (!!value && typeof value === "object" && Object.keys(value).length > 0 && !Object.values(value).some((v) => typeof v === "string"));

/** The first <script id="flash-data"> block of rules: none, its object, or why it can't be used. */
function dataBlock(html: string): Block {
  // Each tag is read only up to its first 300 characters, so a page of any shape is read quickly.
  const tags = /<script\b([^<>]{0,300})>/gi;
  for (let tag; (tag = tags.exec(html)); ) {
    if (!/(?:^|\s)id\s*=\s*(["']?)flash-data\1(?:\s|\/|$)/i.test(tag[1]) || notRules(tag[1])) continue;
    const start = tag.index + tag[0].length;
    const close = /<\/script/gi;
    close.lastIndex = start;
    const end = close.exec(html)?.index ?? -1;
    if (end === -1) return { found: true, problem: "unclosed" };
    if (end - start > MAX_BLOCK_CHARS) return { found: true, problem: "long" };
    const text = html.slice(start, end);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      try {
        value = looseJson(text);
      } catch {
        return { found: true, problem: "json" };
      }
    }
    if (appsOwnData(value)) {
      // Not rules: the next block is looked for after this one.
      tags.lastIndex = end;
      continue;
    }
    return value && typeof value === "object" ? { found: true, value: value as Record<string, unknown> } : { found: true, problem: "shape" };
  }
  return { found: false };
}

/** The rules the app names for its collections, like {"menu":"read","reviews":"add"}. */
export function declaredRules(html: string): Record<string, DataRule> {
  return computeRules(html).app;
}

/** Only real collection names with real rules. fromEntries, so even a collection called __proto__ is just a name. */
function validRules(value: object, max = Infinity): Record<string, DataRule> {
  const entries = Object.entries(value).filter((e): e is [string, DataRule] => COLLECTION.test(e[0]) && isDataRule(e[1]));
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * What Flash keeps about an app's page. An app with a block is strict: a collection it doesn't name
 * takes the block's "*" rule, or is read-only for visitors. Whatever in the block can't be used is
 * read-only for visitors too, never more open, and the owner is told (bad).
 */
export function computeRules(html: string): ComputedRules {
  const code = codeCollections(html);
  const known = code.length ? { code } : {};
  const block = dataBlock(html);
  if (!block.found) return { v: 1, guess: guessRule(html), app: {}, ...known };
  if ("problem" in block) return { v: 1, guess: "read", app: {}, block: true, bad: { why: block.problem, names: [] }, ...known };
  const app: [string, DataRule][] = [];
  const wrong: string[] = [];
  let guess: DataRule = "read";
  for (const [name, rule] of Object.entries(block.value)) {
    if (name === DEFAULT_KEY && isDataRule(rule)) guess = rule;
    else if (!COLLECTION.test(name) || app.length >= MAX_DECLARED) wrong.push(name);
    else {
      // A collection whose rule can't be read is read-only, so a "*" can't open it by mistake.
      app.push([name, isDataRule(rule) ? rule : "read"]);
      if (!isDataRule(rule)) wrong.push(name);
    }
  }
  const bad = wrong.length ? { bad: { why: "entries" as const, names: wrong.slice(0, 10).map((n) => n.slice(0, 40)) } } : {};
  return { v: 1, guess, app: Object.fromEntries(app), block: true, ...bad, ...known };
}

/** Rules saved by computeRules, or null when they are missing or damaged (they are worked out again then). */
export function parseComputed(text: string | null | undefined): ComputedRules | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (value?.v !== 1 || !isDataRule(value.guess) || !value.app || typeof value.app !== "object" || Array.isArray(value.app)) return null;
    const why: unknown = value.bad?.why;
    const bad = ["long", "unclosed", "json", "shape", "entries"].includes(why as string)
      ? { bad: { why: why as BlockProblem, names: Array.isArray(value.bad.names) ? value.bad.names.filter((n: unknown) => typeof n === "string") : [] } }
      : {};
    const code = Array.isArray(value.code) ? { code: value.code.filter((n: unknown): n is string => typeof n === "string" && COLLECTION.test(n)) } : {};
    return {
      v: 1,
      guess: value.guess,
      app: validRules(value.app),
      ...(value.block === true && { block: true as const }),
      ...bad,
      ...(value.fromRecords === true && { fromRecords: true as const }),
      ...code,
    };
  } catch {
    return null;
  }
}

/** The rule that applies: the owner's choice, then the app's, then the owner's default, then the app's default or the guess. */
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
  return { rule: computed.guess, source: computed.block ? "block" : "guess" };
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

/**
 * What publishing reports about the app's data: each collection's rule, the rule for anything else,
 * what Flash couldn't use in the app's flash-data block, the collections only the owner could see
 * that visitors can see after this update because its page no longer names them as private
 * (exposed), and the ones it left read-only for visitors because the block doesn't name them (closed).
 */
export type DataSummary = {
  collections: { name: string; rule: DataRule; source: RuleSource }[];
  other: DataRule;
  bad?: { why: BlockProblem; names: string[] };
  exposed?: string[];
  closed?: string[];
};

const BAD_TEXT: Record<Exclude<BlockProblem, "entries">, string> = {
  long: msg("Flash couldn't read this app's flash-data block because it's too long, so visitors can only read its data until it's fixed."),
  unclosed: msg("Flash couldn't read this app's flash-data block because it has no </script>, so visitors can only read its data until it's fixed."),
  json: msg("Flash couldn't read this app's flash-data block because it isn't valid JSON, so visitors can only read its data until it's fixed."),
  shape: msg(
    "Flash couldn't read this app's flash-data block because it isn't a list of collections and rules, so visitors can only read its data until it's fixed.",
  ),
};

/** What's wrong with the app's flash-data block, in words for the owner, or "". */
export function blockProblem(bad: DataSummary["bad"], t: Translate = english): string {
  if (!bad) return "";
  if (bad.why !== "entries") return t(BAD_TEXT[bad.why]);
  return t("Flash couldn't use part of this app's flash-data block ({names}), so those collections are read-only for visitors until it's fixed.", {
    names: bad.names.join(", "),
  });
}

/**
 * "Who can change this app's data: menu — only you · reviews — visitors can add · anything else — only you. …",
 * after what's wrong with the app's block and what this update showed visitors or closed, if
 * anything. Empty for an app that keeps no shared data of its own, like a plain website. t words it
 * for the owner.
 */
export function dataLine(data: DataSummary, shown = 8, t: Translate = english): string {
  const said: string[] = [];
  if (data.bad) said.push(blockProblem(data.bad, t));
  const exposed = data.exposed ?? [];
  if (exposed.length === 1) {
    said.push(t("Visitors can now see {collection}, which only you could see before. To keep it private, choose Only you can see it for it in My websites & apps › Data.", { collection: exposed[0] }));
  } else if (exposed.length > 1) {
    said.push(
      t("Visitors can now see {collections}, which only you could see before. To keep them private, choose Only you can see it for them in My websites & apps › Data.", {
        collections: exposed.join(", "),
      }),
    );
  }
  const closed = data.closed ?? [];
  if (closed.length === 1) {
    said.push(t("Visitors can no longer add to or change {collection}, because your app's flash-data block doesn't name it.", { collection: closed[0] }));
  } else if (closed.length > 1) {
    said.push(t("Visitors can no longer add to or change {collections}, because your app's flash-data block doesn't name them.", { collections: closed.join(", ") }));
  }
  if (data.collections.length || data.other !== "read") {
    const parts = data.collections.slice(0, shown).map((c) => t("{collection} — {rule}", { collection: c.name, rule: t(RULE_SHORT[c.rule]) }));
    if (data.collections.length > shown) parts.push(t("{count} more", { count: data.collections.length - shown }));
    parts.push(t("anything else — {rule}", { rule: t(RULE_SHORT[data.other]) }));
    said.push(t("Who can change this app's data: {rules}. Change it in My websites & apps › Data.", { rules: parts.join(" · ") }));
  }
  return said.join(" ");
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
