/*
 * The records a published app keeps: window.flashDB. Shared records (owner "") are the app's own
 * data, which everyone using it sees. Records with an owner belong to one person signed in to the
 * app (flashDB.mine), and only they can read or change them.
 *
 * Who may read, add, change or delete shared records depends on each collection's rule (see
 * data-rules.ts), checked here on every request. The caller is anyone, someone signed in to the
 * app, or the app's owner (see site-owner.ts).
 */
import { all, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { toCsv } from "../csv.ts";
import { english, type Translate } from "../i18n.ts";
import {
  ANYONE,
  COLLECTION,
  DEFAULT_KEY,
  OWNER,
  can,
  computeRules,
  effectiveRule,
  isDataRule,
  keepPrivate,
  looksPersonal,
  parseComputed,
  refusal,
  type Caller,
  type ComputedRules,
  type DataAction,
  type DataRule,
  type DataSummary,
  type RuleSource,
} from "../data-rules.ts";

export { COLLECTION };
export const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS_PER_SITE = 5000;
const MAX_BYTES_PER_SITE = 20 * 1024 * 1024;
// A list answer stops after this much data or this many records; the client asks for the rest.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_RECORDS = 1000;
// Rules an owner may choose for one app, so the list stays readable.
const MAX_CHOSEN = 200;

type Row = { id: string; data: string; created_at: number; updated_at: number; author?: string };
export type Answer = { status: number; body: unknown };

/**
 * A record as the app sees it. byYou is set only when the person asking added it; Flash sets it,
 * never the app. Everything else the app saved comes back as it was, its own authorId included.
 */
function toRecord(r: Row, caller: Caller = ANYONE) {
  const data = JSON.parse(r.data);
  delete data.byYou;
  const byYou = caller.kind === "visitor" && !!r.author && r.author === caller.id;
  return { ...data, id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, ...(byYou && { byYou: true }) };
}
const fail = (error: string, status: number): Answer => ({ status, body: { error } });
const refused = (rule: DataRule, action: DataAction, caller: Caller): Answer => {
  const { status, error } = refusal(rule, action, caller);
  return fail(error, status);
};

export async function siteExists(slug: string): Promise<boolean> {
  return Boolean(await one("SELECT 1 FROM sites WHERE slug = ?", [slug]));
}

/**
 * Whether a page's rules, worked out from its code, would lock out code Flash can't see: the page
 * has no flash-data block and no flashDB code of its own (it loads its code from elsewhere), yet
 * shared records are there for it to use.
 */
const unseenCode = (html: string, computed: ComputedRules) => !computed.block && computed.guess === "read" && !/\bflashDB\b/.test(html);
const hasShared = async (slug: string) => Boolean(await one("SELECT 1 FROM site_records WHERE site_slug = ? AND owner = '' LIMIT 1", [slug]));
// Such an app made before rules existed keeps working as it did: anyone may change its data, until its page names its rules.
const asBefore = (computed: ComputedRules): ComputedRules => ({ ...computed, guess: "open", fromRecords: true });

/**
 * The rules to save with a new page for an app (slug null for a new app), as sites.data_rules. When
 * Flash can't use (all of) the new page's flash-data block, what only the owner could see stays
 * private (see keepPrivate). An app that was kept open because code Flash can't see uses its
 * records (or would have been, made before rules and not used since) stays open while the new page
 * still has neither a flash-data block nor flashDB code of its own.
 */
export async function rulesForPage(slug: string | null, html: string): Promise<string> {
  const computed = computeRules(html);
  if (slug && (computed.bad || unseenCode(html, computed))) {
    const saved = await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = ?", [slug]);
    const before = parseComputed(saved?.data_rules);
    if (computed.bad) return JSON.stringify(keepPrivate(computed, before));
    if (before ? before.fromRecords : saved && (await hasShared(slug))) return JSON.stringify(asBefore(computed));
  }
  return JSON.stringify(computed);
}

/**
 * Works out an app's rules from its page again and keeps them. Apps published before rules existed
 * get theirs this way, the first time their data is used.
 */
export async function refreshRules(slug: string): Promise<ComputedRules | null> {
  const site = await one<{ html: string; updated_at: number }>("SELECT html, updated_at FROM sites WHERE slug = ?", [slug]);
  if (!site) return null;
  let computed = computeRules(site.html);
  if (unseenCode(site.html, computed) && (await hasShared(slug))) computed = asBefore(computed);
  await keepRules(slug, computed, Number(site.updated_at));
  return computed;
}

/** Saves rules worked out from the page as it was at seenAt, unless the page was replaced since: publishing saves the new page's rules with it. */
export async function keepRules(slug: string, computed: ComputedRules, seenAt: number): Promise<boolean> {
  const r = await run("UPDATE sites SET data_rules = ? WHERE slug = ? AND updated_at = ?", [JSON.stringify(computed), slug, seenAt]);
  return r.rowsAffected > 0;
}

/** The rule for one collection of an app's shared data, and where it comes from, or null when there's no such app. */
export async function collectionRule(slug: string, collection: string): Promise<{ rule: DataRule; source: RuleSource } | null> {
  const row = await one<{ computed: string; chosen: string | null; fallback: string | null }>(
    `SELECT s.data_rules AS computed,
       (SELECT rule FROM site_collection_rules WHERE site_slug = s.slug AND collection = ?) AS chosen,
       (SELECT rule FROM site_collection_rules WHERE site_slug = s.slug AND collection = ?) AS fallback
     FROM sites s WHERE s.slug = ?`,
    [collection, DEFAULT_KEY, slug],
  );
  if (!row) return null;
  const computed = parseComputed(row.computed) ?? (await refreshRules(slug));
  return computed && effectiveRule(computed, row.chosen, row.fallback, collection);
}

/** The owner picks who may change a collection ("*" for every other one), or goes back to the app's choice with null. */
export async function chooseRule(slug: string, collection: string, rule: DataRule | null): Promise<boolean> {
  if (collection !== DEFAULT_KEY && !COLLECTION.test(collection)) return false;
  if (rule === null) {
    await run("DELETE FROM site_collection_rules WHERE site_slug = ? AND collection = ?", [slug, collection]);
    return true;
  }
  if (!isDataRule(rule)) return false;
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_collection_rules WHERE site_slug = ? AND collection != ?", [
    slug,
    collection,
  ]);
  if (Number(count?.n ?? 0) >= MAX_CHOSEN) return false;
  await run(
    `INSERT INTO site_collection_rules (site_slug, collection, rule, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (site_slug, collection) DO UPDATE SET rule = excluded.rule, updated_at = excluded.updated_at`,
    [slug, collection, rule, now()],
  );
  return true;
}

/** Whether a site has room for `extra` more bytes of data (and one more record when adding). */
async function hasRoom(slug: string, extra: number, adding: boolean): Promise<boolean> {
  const use = await one<{ n: number; bytes: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM site_records WHERE site_slug = ?",
    [slug],
  );
  if (adding && Number(use?.n ?? 0) >= MAX_RECORDS_PER_SITE) return false;
  return Number(use?.bytes ?? 0) + extra <= MAX_BYTES_PER_SITE;
}

function cleanData(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  // Flash sets these fields itself, so the app can't overwrite them.
  const rest = { ...(data as Record<string, unknown>) };
  delete rest.id;
  delete rest.createdAt;
  delete rest.updatedAt;
  delete rest.byYou;
  const text = JSON.stringify(rest);
  return text.length <= MAX_RECORD_BYTES ? text : null;
}

/**
 * Who may change shared records in this collection: everyone the rule lets change any record
 * (author null), only the signed-in person who added the record (their id), or nobody (the answer to send).
 */
async function changeGate(slug: string, collection: string, caller: Caller): Promise<{ rule: DataRule; author: string | null } | Answer> {
  const found = await collectionRule(slug, collection);
  if (!found) return fail("App not found.", 404);
  const { rule } = found;
  if (can(rule, "change", caller)) return { rule, author: null };
  if (caller.kind === "visitor" && can(rule, "change", caller, caller.id)) return { rule, author: caller.id };
  return refused(rule, "change", caller);
}

/**
 * Lists a collection, oldest first, in pages of up to 2 MB. When more is true, ask again with the
 * returned cursor (window.flashDB.list does this itself). owner "" is the app's shared records.
 */
export async function listRecords(slug: string, collection: string, cursor: string, owner: string, caller: Caller = ANYONE): Promise<Answer> {
  if (!COLLECTION.test(collection)) return fail("Invalid collection name.", 400);
  if (owner === "") {
    const found = await collectionRule(slug, collection);
    if (!found) return fail("App not found.", 404);
    if (!can(found.rule, "read", caller)) return refused(found.rule, "read", caller);
  } else if (!(await siteExists(slug))) return fail("App not found.", 404);
  // The cursor is the last record's createdAt and id, so records added meanwhile aren't skipped.
  const [afterTime, afterId = ""] = cursor.split(":");
  const after = Number(afterTime) || 0;
  const rows = await all<Row>(
    `SELECT id, data, created_at, updated_at, author FROM site_records
     WHERE site_slug = ? AND collection = ? AND owner = ? AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at, id LIMIT ?`,
    [slug, collection, owner, after, after, afterId, MAX_PAGE_RECORDS + 1],
  );
  const page: Row[] = [];
  let bytes = 0;
  for (const r of rows.slice(0, MAX_PAGE_RECORDS)) {
    if (page.length && bytes + r.data.length > MAX_PAGE_BYTES) break;
    page.push(r);
    bytes += r.data.length;
  }
  const more = page.length < rows.length;
  const lastRow = page.at(-1);
  return {
    status: 200,
    body: { records: page.map((r) => toRecord(r, caller)), more, ...(more && lastRow && { cursor: `${lastRow.created_at}:${lastRow.id}` }) },
  };
}

export async function addRecord(slug: string, collection: unknown, data: unknown, owner: string, caller: Caller = ANYONE): Promise<Answer> {
  if (typeof collection !== "string" || !COLLECTION.test(collection)) return fail("Invalid collection name.", 400);
  const clean = cleanData(data);
  if (!clean) return fail("Records must be objects under 64 KB.", 400);
  if (owner === "") {
    const found = await collectionRule(slug, collection);
    if (!found) return fail("App not found.", 404);
    if (!can(found.rule, "add", caller)) return refused(found.rule, "add", caller);
  } else if (!(await siteExists(slug))) return fail("App not found.", 404);
  if (!(await hasRoom(slug, clean.length, true))) return fail("This app's storage is full.", 507);
  // A shared record remembers who added it when they were signed in, so they can change it later.
  const author = owner === "" && caller.kind === "visitor" ? caller.id : "";
  const row: Row = { id: randomId(9), data: clean, created_at: now(), updated_at: now(), author };
  // INSERT … SELECT, so a record sent just as the app is unpublished isn't left behind without it.
  const r = await run(
    `INSERT INTO site_records (id, site_slug, collection, data, created_at, updated_at, owner, author)
     SELECT ?, slug, ?, ?, ?, ?, ?, ? FROM sites WHERE slug = ?`,
    [row.id, collection, clean, row.created_at, row.updated_at, owner, author, slug],
  );
  if (!r.rowsAffected) return fail("App not found.", 404);
  return { status: 201, body: { record: toRecord(row, caller) } };
}

export async function patchRecord(
  slug: string,
  collection: unknown,
  id: unknown,
  data: unknown,
  owner: string,
  caller: Caller = ANYONE,
): Promise<Answer> {
  const name = typeof collection === "string" ? collection : "";
  const args = [slug, name, typeof id === "string" ? id : "", owner];
  let gate: { rule: DataRule; author: string | null } = { rule: "open", author: null };
  if (owner === "") {
    if (!COLLECTION.test(name)) return fail("Record not found.", 404);
    const found = await changeGate(slug, name, caller);
    if ("status" in found) return found;
    gate = found;
  }
  const select = "SELECT id, data, created_at, updated_at, author FROM site_records WHERE site_slug = ? AND collection = ? AND id = ? AND owner = ?";
  const existing = gate.author === null ? await one<Row>(select, args) : await one<Row>(`${select} AND author = ?`, [...args, gate.author]);
  if (!existing) {
    // Someone else's record is refused; one that isn't there is simply not found.
    if (gate.author !== null && (await one(select, args))) return refused(gate.rule, "change", caller);
    return fail("Record not found.", 404);
  }
  const patch = cleanData(data);
  if (!patch) return fail("Records must be objects under 64 KB.", 400);
  const merged = JSON.stringify({ ...JSON.parse(existing.data), ...JSON.parse(patch) });
  if (merged.length > MAX_RECORD_BYTES) return fail("Records must be under 64 KB.", 400);
  if (merged.length > existing.data.length && !(await hasRoom(slug, merged.length - existing.data.length, false))) {
    return fail("This app's storage is full.", 507);
  }
  const updated = now();
  await run("UPDATE site_records SET data = ?, updated_at = ? WHERE id = ?", [merged, updated, existing.id]);
  return { status: 200, body: { record: toRecord({ ...existing, data: merged, updated_at: updated }, caller) } };
}

export async function removeRecord(slug: string, collection: string, id: string, owner: string, caller: Caller = ANYONE): Promise<Answer> {
  const args = [slug, collection, id, owner];
  const where = "WHERE site_slug = ? AND collection = ? AND id = ? AND owner = ?";
  if (owner !== "") {
    await run(`DELETE FROM site_records ${where}`, args);
    return { status: 200, body: { ok: true } };
  }
  // No record can have a name like that, so there is nothing to delete.
  if (!COLLECTION.test(collection)) return { status: 200, body: { ok: true } };
  const gate = await changeGate(slug, collection, caller);
  if ("status" in gate) return gate;
  if (gate.author === null) {
    await run(`DELETE FROM site_records ${where}`, args);
    return { status: 200, body: { ok: true } };
  }
  const r = await run(`DELETE FROM site_records ${where} AND author = ?`, [...args, gate.author]);
  if (!r.rowsAffected && (await one(`SELECT 1 FROM site_records ${where}`, args))) return refused(gate.rule, "change", caller);
  // A record that's already gone is fine, as before.
  return { status: 200, body: { ok: true } };
}

/** An app's rules: what its page says, and what its owner chose (with "*" for anything else). */
async function siteRules(slug: string): Promise<{ computed: ComputedRules; chosen: Record<string, DataRule> } | null> {
  const site = await one<{ data_rules: string }>("SELECT data_rules FROM sites WHERE slug = ?", [slug]);
  if (!site) return null;
  const computed = parseComputed(site.data_rules) ?? (await refreshRules(slug));
  if (!computed) return null;
  const rows = await all<{ collection: string; rule: string }>("SELECT collection, rule FROM site_collection_rules WHERE site_slug = ?", [slug]);
  return { computed, chosen: Object.fromEntries(rows.filter((r) => isDataRule(r.rule)).map((r) => [r.collection, r.rule as DataRule])) };
}

export type SharedCollection = { name: string; count: number; lastAdded: number; rule: DataRule; source: RuleSource; personal: string[] };
export type SharedData = {
  collections: SharedCollection[];
  fallback: DataRule | null;
  guess: DataRule;
  // The app has a flash-data block, and what Flash couldn't use in it.
  block: boolean;
  bad?: ComputedRules["bad"];
};

/**
 * For the owner: each collection of shared data with how many records it has, its rule, and the
 * field names of its newest record that look like personal details. Collections the app, its code
 * or the owner named are listed even while empty.
 */
export async function sharedCollections(slug: string): Promise<SharedData | null> {
  const rules = await siteRules(slug);
  if (!rules) return null;
  const { computed, chosen } = rules;
  const counts = await all<{ collection: string; n: number; last: number }>(
    `SELECT collection, COUNT(*) AS n, MAX(created_at) AS last FROM site_records
     WHERE site_slug = ? AND owner = '' GROUP BY collection ORDER BY last DESC LIMIT 200`,
    [slug],
  );
  // Only the field names of each collection's newest record, not the records themselves.
  const fields = await all<{ collection: string; key: string }>(
    `SELECT DISTINCT r.collection, j.key FROM
       (SELECT collection, data, ROW_NUMBER() OVER (PARTITION BY collection ORDER BY created_at DESC) AS rn
        FROM site_records WHERE site_slug = ? AND owner = '') r,
       json_each(CASE WHEN json_valid(r.data) THEN r.data ELSE '{}' END) j
     WHERE r.rn = 1`,
    [slug],
  );
  const keys = new Map<string, string[]>();
  for (const f of fields) keys.set(f.collection, [...(keys.get(f.collection) ?? []), String(f.key)]);
  const seen = new Map(counts.map((c) => [c.collection, c]));
  const names = [...new Set([...seen.keys(), ...namedBy(computed, chosen)])];
  const collections = names.map((name) => {
    const { rule, source } = effectiveRule(computed, chosen[name], chosen[DEFAULT_KEY], name);
    const c = seen.get(name);
    return { name, count: Number(c?.n ?? 0), lastAdded: Number(c?.last ?? 0), rule, source, personal: looksPersonal(keys.get(name) ?? []) };
  });
  return { collections, fallback: chosen[DEFAULT_KEY] ?? null, guess: computed.guess, block: Boolean(computed.block), ...(computed.bad && { bad: computed.bad }) };
}

/** The collections the app's block, its code and the owner name. */
const namedBy = (computed: ComputedRules, chosen: Record<string, DataRule>) => [
  ...Object.keys(computed.app),
  ...(computed.code ?? []),
  ...Object.keys(chosen).filter((n) => n !== DEFAULT_KEY),
];

/**
 * What publishing reports: the rule of each collection the app, its code, the owner or its records
 * name, of anything else, and what Flash couldn't use in the app's flash-data block.
 */
export async function dataSummary(slug: string): Promise<DataSummary | null> {
  const rules = await siteRules(slug);
  if (!rules) return null;
  const { computed, chosen } = rules;
  const used = await all<{ collection: string }>("SELECT DISTINCT collection FROM site_records WHERE site_slug = ? AND owner = '' LIMIT 50", [slug]);
  const names = [...new Set([...namedBy(computed, chosen), ...used.map((u) => u.collection)])];
  return {
    collections: names.map((name) => ({ name, ...effectiveRule(computed, chosen[name], chosen[DEFAULT_KEY], name) })),
    other: chosen[DEFAULT_KEY] ?? computed.guess,
    ...(computed.bad && { bad: computed.bad }),
  };
}

/**
 * For the owner: a collection's newest shared records, with the email of the signed-in person who
 * added each. The app's own fields are kept apart, so none of them can pass for Flash's.
 */
export async function newestShared(slug: string, collection: string, limit = 100) {
  const rows = await all<Row & { added_by: string | null }>(
    `SELECT r.id, r.data, r.created_at, r.updated_at, r.author, u.email AS added_by FROM site_records r
     LEFT JOIN site_users u ON u.id = r.author AND u.site_slug = r.site_slug
     WHERE r.site_slug = ? AND r.collection = ? AND r.owner = '' ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    [slug, collection, limit],
  );
  return rows.map((r) => {
    const { id, createdAt, updatedAt, ...data } = toRecord(r, OWNER);
    return { id: id as string, createdAt: Number(createdAt), updatedAt: Number(updatedAt), addedBy: r.added_by ?? "", data };
  });
}

/**
 * For the owner: a collection as a CSV file, newest first. A response can't be much over 4 MB, so
 * the rows stop before maxBytes, and included says how many made it.
 */
export async function sharedCsv(
  slug: string,
  collection: string,
  t: Translate = english,
  maxBytes = 4_000_000,
): Promise<{ csv: string; included: number; total: number }> {
  const rows = await all<Row>(
    "SELECT id, data, created_at, updated_at FROM site_records WHERE site_slug = ? AND collection = ? AND owner = '' ORDER BY created_at DESC, id DESC",
    [slug, collection],
  );
  const records = rows.map((r) => ({ id: r.id, createdAt: Number(r.created_at), data: JSON.parse(r.data) as Record<string, unknown> }));
  const fields = [...new Set(records.flatMap((r) => Object.keys(r.data)))].slice(0, 50);
  const header = [t("Added"), ...fields, "id"];
  // Numbers stay numbers, so a spreadsheet can add them up (see toCsv).
  const cell = (v: unknown) => (typeof v === "string" || typeof v === "number" || v === undefined ? v : JSON.stringify(v));
  const lines: unknown[][] = [];
  let bytes = Buffer.byteLength(toCsv([header]));
  for (const r of records) {
    const line = [new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " "), ...fields.map((f) => cell(r.data[f])), r.id];
    // Each row's own size, without the 3-byte mark toCsv starts every file with.
    const size = Buffer.byteLength(toCsv([line])) - 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    lines.push(line);
  }
  return { csv: toCsv([header, ...lines]), included: lines.length, total: records.length };
}
