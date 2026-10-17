/*
 * Each published app's contact list: one row per person the app heard from, whichever way they
 * came (a form sent with flashDB.send, a flashAuth sign-up, a paid order, or its owner adding them),
 * matched by email address without regard to case, or by phone number for someone who gave no
 * email. Nobody proves a phone number is theirs, so a number never joins an email's contact to one
 * known by that number alone: each one's details name the other instead. Only the app's owner sees it, in My websites & apps › Contacts, where they move people
 * through their own stages, tag them, write notes, and download, export or delete each one: the
 * owner is in charge of this data, and unpublishing the app deletes it with everything else.
 *
 * Agreeing to an app's news counts only when the person ticked a box themselves (see flashdb-shim.ts)
 * whose wording a visitor sees on the app's page. Flash keeps that wording, the time, the form, and
 * a hash of their address keyed by the app's own secret, never the address. Anyone can send a form
 * with someone else's address, so a ticked box never undoes an unsubscribe: once someone has
 * unsubscribed, only the owner can record that they asked for news again, with a note saying how.
 * The same secret signs each contact's unsubscribe link, which is worked out again whenever it's
 * shown, so no usable link is stored. Flash sends no news itself: the list shows who agreed and
 * who unsubscribed.
 *
 * It costs only database rows, within the caps below, and fills without slowing anyone down: a
 * contact that can't be saved never stops the form, the sign-up or the order it came with.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { InStatement, InValue } from "@libsql/client";
import { emailKey } from "./account.ts";
import { all, db, one, run, now } from "./db.ts";
import { randomId } from "./ids.ts";
import { removeSiteUser } from "./site-auth.ts";
import { toCsv } from "../csv.ts";
import { formatMoney } from "../shop.ts";
import {
  DEFAULT_STAGES,
  MAX_CONSENT_NOTE,
  MAX_CONTACTS,
  MAX_NAME,
  MAX_NOTES,
  MAX_STAGES,
  MAX_STAGE_NAME,
  cleanContact,
  cleanEmail,
  cleanName,
  cleanTags,
  contactFromFields,
  contactMatches,
  normalPhone,
  pageHas,
  sourceLabel,
  stageOf,
  stagesOf,
  type Stage,
  type Who,
} from "../contacts.ts";
import { english, type Translate } from "../i18n.ts";

/** What someone agreed to get by ticking a box: its wording, the form it was on, and their address hashed. */
export type Consent = { text: string; ipHash: string; form: string };
/** One time the app heard from someone: how ("form:contact", "signup", "order:Cake", "owner"), and when. */
export type Seen = { source: string; at: number; consent?: Consent | null; messageId?: string };

export type Contact = {
  id: string;
  email: string;
  phone: string;
  name: string;
  stage: string;
  tags: string[];
  notes: string;
  source: string;
  firstSeen: number;
  lastSeen: number;
  // What they agreed to: the wording they saw on a form (by "form"), or the owner's note on how they
  // asked for news again after unsubscribing (by "owner", with no form).
  consent: { text: string; at: number; form: string; by: "form" | "owner" } | null;
  unsubscribedAt: number;
  // They agreed to news, and haven't unsubscribed since (see unsubscribedNow).
  subscribed: boolean;
};

type Row = {
  id: string;
  email: string;
  phone: string;
  name: string;
  stage: string;
  tags: string;
  notes: string;
  source: string;
  first_seen: number;
  last_seen: number;
  consent_text: string;
  consent_at: number;
  consent_ip?: string;
  consent_channel?: string;
  consent_form: string;
  consent_by: string;
  unsubscribed_at: number;
};

// The list and the board leave out the hashed address; the export and the file have it.
const LISTED = "id, email, phone, name, stage, tags, notes, source, first_seen, last_seen, consent_text, consent_at, consent_form, consent_by, unsubscribed_at";
// How many the list and a search show at once, how many the board shows per stage, and below how
// many the whole list comes at once (the page then searches and lays out the board itself).
const SHOWN = 500;
const PER_STAGE = 100;
// A reply can't be much over 4.5 MB on the host, so a contact's export stays under 4 MB.
const EXPORT_BYTES = 3_600_000;

// A box ticked on a form counts only for someone who never unsubscribed. Anyone can send a form with
// someone else's address, so it can't bring back someone who said no: after an unsubscribe, only
// the owner can record that they asked for news again (see recordConsent).
const FORM_AGREES = "excluded.consent_at > consent_at AND unsubscribed_at = 0";
/**
 * Whether someone is unsubscribed now: they used their link, and the owner hasn't recorded since
 * then that they asked for news again. Only the owner's record comes after an unsubscribe, so a
 * form's agreement after one never counts, including one taken before FORM_AGREES (#114 let a
 * newer tick win). UNSUBSCRIBED says the same in SQL.
 */
const unsubscribedNow = (r: { unsubscribed_at: number; consent_at: number; consent_by: string }) =>
  Number(r.unsubscribed_at) > 0 && (r.consent_by !== "owner" || Number(r.unsubscribed_at) >= Number(r.consent_at));
const UNSUBSCRIBED = "unsubscribed_at > 0 AND (consent_by <> 'owner' OR unsubscribed_at >= consent_at)";

/**
 * What a new sighting changes on a contact already on the list: the name and phone fill in only
 * while it has none, the earliest sighting says where they came from, and a newer agreement to news
 * replaces an older one while they've never unsubscribed. The owner's own stage, tags and notes
 * never change, an unsubscribe stays, and the owner adding someone who is already there doesn't
 * count as seeing them.
 */
const MERGE = `
  name = CASE WHEN name = '' THEN excluded.name ELSE name END,
  phone = CASE WHEN phone = '' THEN excluded.phone ELSE phone END,
  source = CASE WHEN excluded.first_seen < first_seen THEN excluded.source ELSE source END,
  first_seen = min(first_seen, excluded.first_seen),
  last_seen = CASE WHEN excluded.source = 'owner' THEN last_seen ELSE max(last_seen, excluded.last_seen) END,
  consent_text = CASE WHEN ${FORM_AGREES} THEN excluded.consent_text ELSE consent_text END,
  consent_ip = CASE WHEN ${FORM_AGREES} THEN excluded.consent_ip ELSE consent_ip END,
  consent_channel = CASE WHEN ${FORM_AGREES} THEN excluded.consent_channel ELSE consent_channel END,
  consent_form = CASE WHEN ${FORM_AGREES} THEN excluded.consent_form ELSE consent_form END,
  consent_by = CASE WHEN ${FORM_AGREES} THEN '' ELSE consent_by END,
  consent_at = CASE WHEN ${FORM_AGREES} THEN excluded.consent_at ELSE consent_at END`;
const COLUMNS = "id, site_slug, email, phone, name, source, first_seen, last_seen, consent_text, consent_at, consent_ip, consent_channel, consent_form";
/**
 * Counts the app's contacts when it has no count yet: the first time someone may join them, and
 * once more after the people it had before are copied in (see fillFrom). From then on the database
 * keeps the count as people are added and deleted (site_contact_counts in db.ts), so a new contact
 * checks the cap by reading one row, not by counting the whole list.
 */
const counted = (slug: string): InStatement => ({
  sql: `INSERT INTO site_contact_counts (site_slug, n)
        SELECT slug, (SELECT COUNT(*) FROM site_contacts WHERE site_slug = ?) FROM sites
        WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM site_contact_counts WHERE site_slug = ?)
        ON CONFLICT(site_slug) DO NOTHING`,
  args: [slug, slug, slug],
});
// Room for one more, unless they are on the list already (key is the condition that finds them).
// counted goes first in the same write, so the count is there; without one there's no room.
const room = (key: string) =>
  `(EXISTS (SELECT 1 FROM site_contacts WHERE site_slug = ? AND ${key}) OR (SELECT n FROM site_contact_counts WHERE site_slug = ?) < ${MAX_CONTACTS})`;
// The contact with an email address, and the one known by a phone number alone.
const BY_EMAIL = "email = ? AND email <> ''";
const ID_BY_EMAIL = `SELECT id FROM site_contacts WHERE site_slug = ? AND ${BY_EMAIL}`;
const PHONE_ONLY = "email = '' AND phone = ? AND phone <> ''";
const ID_BY_PHONE = `SELECT id FROM site_contacts WHERE site_slug = ? AND ${PHONE_ONLY}`;
// An address with a character outside ASCII, which may be another spelling than contacts keep (see
// cleanEmail): as a member typed it, as Stripe gave it before, or a contact saved before.
const NOT_ASCII = "email GLOB '*[^ -~]*'";
/**
 * The ways an address kept lowercased as a whole (a member's, or a contact #114 kept) may be read:
 * as it is, and with each "ς" in its domain as "σ". Lowercasing a whole domain makes a Greek "Σ"
 * before a digit, a hyphen or its end "ς", where cleanEmail, as browsers, reads it as "σ".
 */
function spellings(email: string): string[] {
  const at = email.lastIndexOf("@") + 1;
  const domain = email.slice(at);
  return domain.includes("ς") ? [email, email.slice(0, at) + domain.replace(/ς/g, "σ")] : [email];
}

/**
 * What finds the app's members (site_users) or orders (site_orders) with a contact's address,
 * after "site_slug = ? AND": written the same but for the case of A to Z, or in another spelling of
 * it. A member keeps the address as they typed it to sign in with it, so jo@bäckerei.de is the
 * member of the contact jo@xn--bckerei-5wa.de. Only rows with a character outside ASCII are read
 * to check their spelling, through an index of those rows alone, and members are found through the
 * index of their addresses, so an app whose addresses are all in ASCII reads no more than before.
 */
async function withAddress(table: "site_users" | "site_orders", slug: string, email: string): Promise<{ sql: string; args: InValue[] }> {
  const member = table === "site_users";
  const key = member ? "id" : "session_id";
  const kept = cleanEmail(email) || email;
  const rows = await all<{ k: string; email: string }>(`SELECT ${key} AS k, email FROM ${table} WHERE site_slug = ? AND ${NOT_ASCII}`, [slug]);
  // A member's address is kept lowercased as a whole (see siteAuth), so it's read both ways.
  const others = rows.filter((r) => (member ? spellings(r.email) : [r.email]).some((text) => cleanEmail(text) === kept)).map((r) => r.k);
  // site_users.email is COLLATE NOCASE, so "=" there is lower() without losing the index.
  const same = member ? "email IN (?, ?)" : "lower(email) IN (?, ?)";
  return { sql: others.length ? `(${same} OR ${key} IN (${others.map(() => "?").join(", ")}))` : same, args: [email, kept, ...others] };
}

const hmac = (secret: string, text: string) => createHmac("sha256", secret).update(text);

/**
 * The app's own secret for its contacts, made the first time it's needed. Two first uses at once
 * agree on one, as only the first can set it. "" when there's no such app.
 */
export async function siteSecret(slug: string): Promise<string> {
  const read = async () => (await one<{ contact_secret: string }>("SELECT contact_secret FROM sites WHERE slug = ?", [slug]))?.contact_secret ?? "";
  const secret = await read();
  if (secret) return secret;
  await run("UPDATE sites SET contact_secret = ? WHERE slug = ? AND contact_secret = ''", [randomId(32), slug]);
  return read();
}

/** An address, hashed with the app's secret: Flash can tell two of them apart, nobody can read it back. */
export const hashedIp = (secret: string, ip: string) => hmac(secret, `ip|${ip}`).digest("hex").slice(0, 24);

/**
 * What someone agreed to get, when a form says they ticked the news box ({ text } from flashDB.send):
 * kept only when a visitor sees that wording on the app's published page (not just in its code),
 * so made-up wording is never stored. null otherwise; it never stops the message.
 */
export async function checkedConsent(slug: string, raw: unknown, ip: string, form: string): Promise<Consent | null> {
  const given = raw && typeof raw === "object" ? (raw as { text?: unknown }).text : undefined;
  if (typeof given !== "string" || given.length > 2000) return null;
  const text = given.replace(/\s+/g, " ").trim();
  if (!text || text.length > 300) return null;
  const site = await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]);
  if (!site || !pageHas(site.html, text)) return null;
  const secret = await siteSecret(slug);
  return secret ? { text, ipHash: hashedIp(secret, ip), form } : null;
}

/**
 * The statements that put someone on the app's list or bring them up to date, and (with select)
 * read back their id last. Each insert reads the site, so nothing is left behind by an unpublish,
 * and the list holds at most MAX_CONTACTS: past that only people already on it change. A message
 * passed as messageId is linked to its contact.
 */
function contactStatements(slug: string, who: Who, { source, at, consent = null, messageId = "" }: Seen, select = true): InStatement[] {
  const statements: InStatement[] = [counted(slug)];
  if (who.email) {
    const agreed: InValue[] = consent ? [consent.text, at, consent.ipHash, "email", consent.form] : ["", 0, "", "", ""];
    statements.push({
      sql: `INSERT INTO site_contacts (${COLUMNS})
            SELECT ?, slug, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM sites WHERE slug = ? AND ${room(BY_EMAIL)}
            ON CONFLICT(site_slug, email) WHERE email <> '' DO UPDATE SET ${MERGE}`,
      args: [randomId(12), who.email, who.phone, who.name, source, at, at, ...agreed, slug, slug, who.email, slug],
    });
    if (messageId) {
      statements.push({
        sql: `UPDATE site_messages SET contact_id = COALESCE((${ID_BY_EMAIL}), '') WHERE site_slug = ? AND id = ?`,
        args: [slug, who.email, slug, messageId],
      });
    }
    if (select) statements.push({ sql: ID_BY_EMAIL, args: [slug, who.email] });
    return statements;
  }
  // A phone number alone (news by email can't be agreed to without an email address) is the contact
  // known by that number alone, never one with an email address that has it: whoever typed the
  // number would otherwise put someone else's messages and the owner's notes on them in their data.
  statements.push({
    sql: `INSERT INTO site_contacts (${COLUMNS})
          SELECT ?, slug, '', ?, ?, ?, ?, ?, '', 0, '', '', '' FROM sites
          WHERE slug = ? AND ${room(PHONE_ONLY)}
          ON CONFLICT(site_slug, phone) WHERE email = '' AND phone <> '' DO UPDATE SET ${MERGE}`,
    args: [randomId(12), who.phone, who.name, source, at, at, slug, slug, who.phone, slug],
  });
  if (messageId) {
    statements.push({
      sql: `UPDATE site_messages SET contact_id = COALESCE((${ID_BY_PHONE}), '') WHERE site_slug = ? AND id = ?`,
      args: [slug, who.phone, slug, messageId],
    });
  }
  if (select) statements.push({ sql: ID_BY_PHONE, args: [slug, who.phone] });
  return statements;
}

/** Puts someone on the app's list, or brings them up to date. Their id, or "" when the list is full or the app is gone. */
export async function noteContact(slug: string, who: Who, seen: Seen): Promise<string> {
  const results = await (await db()).batch(contactStatements(slug, who, seen), "write");
  const row = results.at(-1)?.rows[0] as unknown as { id: string } | undefined;
  return row?.id ?? "";
}

/**
 * The app's contacts that `which` (SQL) picks whose address reaches the same mailbox as email: the
 * same address with a +tag, or for Gmail with dots (see emailKey). Only those at that address's
 * domain are read, and those whose address has a letter outside ASCII: one saved before addresses
 * were kept in one spelling (see cleanEmail) may write the same domain another way, and is read in
 * that spelling here, as #114 kept it (see spellings).
 */
async function sameMailbox(slug: string, email: string, which: string): Promise<{ id: string; email: string }[]> {
  const mailbox = (text: string) => emailKey(cleanEmail(text) || text);
  const keys = new Set(spellings(email).map(mailbox));
  const domains = [...new Set([...keys].map((key) => key.slice(key.lastIndexOf("@"))))].flatMap((d) => (d === "@gmail.com" ? [d, "@googlemail.com"] : [d]));
  const rows = await all<{ id: string; email: string }>(
    `SELECT id, email FROM site_contacts WHERE site_slug = ? AND ${which}
     AND (${domains.map(() => "email LIKE ?").join(" OR ")} OR ${NOT_ASCII})`,
    [slug, ...domains.map((d) => `%${d}`)],
  );
  return rows.filter((r) => spellings(r.email).some((text) => keys.has(mailbox(text))));
}

/** Whether someone on the app's list whose address reaches the same mailbox as email has unsubscribed. */
const mailboxUnsubscribed = async (slug: string, email: string) => (await sameMailbox(slug, email, "unsubscribed_at > 0")).length > 0;

/**
 * A form's sender, for receiveMessage: who they are from its fields, and what they agreed to. "" when
 * the form had no email or phone. A box ticked with an address that reaches the mailbox of someone
 * who unsubscribed counts no more than one ticked with their own address (see FORM_AGREES).
 */
export async function noteSender(slug: string, form: string, data: Record<string, unknown>, consent: unknown, ip: string, at: number, messageId: string) {
  const who = contactFromFields(data);
  if (!who) return "";
  const checked = who.email && consent ? await checkedConsent(slug, consent, ip, form).catch(() => null) : null;
  const agreed = checked && !(await mailboxUnsubscribed(slug, who.email)) ? checked : null;
  return noteContact(slug, who, { source: `form:${form}`, at, consent: agreed, messageId });
}

/**
 * Copies in, once, the people an app heard from before it had a contact list: its members, the
 * buyers of its paid orders, and the senders of its form messages, without duplicates. Each step can
 * run again, so a reply that times out simply carries on next time. It runs when the owner first
 * opens Contacts, never on a visitor's request. Nobody copied in has agreed to news, which is true.
 */
export async function fillContacts(slug: string): Promise<void> {
  const site = await one<{ contacts_filled: number }>("SELECT contacts_filled FROM sites WHERE slug = ?", [slug]);
  if (!site || Number(site.contacts_filled)) return;
  await fillFrom(
    slug,
    `SELECT lower(trim(email)) AS e, trim(name) AS nm, 'signup' AS src, created_at AS at, id AS k
     FROM site_users WHERE site_slug = ? AND instr(email, '@') > 1 AND length(email) <= 160 AND NOT (${NOT_ASCII})`,
  );
  await fillFrom(
    slug,
    `SELECT lower(trim(email)) AS e, trim(name) AS nm, 'order:' || substr(item, 1, 60) AS src, created_at AS at, session_id AS k
     FROM site_orders WHERE site_slug = ? AND instr(trim(email), '@') > 1 AND length(trim(email)) <= 160 AND NOT (${NOT_ASCII})`,
  );
  // Members and buyers whose address has a character outside ASCII are read here, as messages are,
  // so they're kept in the spelling contacts keep (see cleanEmail): the contact their messages join.
  const others = await all<{ email: string; name: string; src: string; at: number }>(
    `SELECT email, name, 'signup' AS src, created_at AS at FROM site_users WHERE site_slug = ? AND ${NOT_ASCII}
     UNION ALL
     SELECT email, name, 'order:' || substr(item, 1, 60), created_at FROM site_orders WHERE site_slug = ? AND ${NOT_ASCII}
     ORDER BY at LIMIT ${MAX_CONTACTS}`,
    [slug, slug],
  );
  const seen: [Who | null, Seen][] = [];
  for (const o of others) {
    const who = cleanContact({ email: o.email, name: o.name });
    // A member's address is lowercased as a whole (see spellings): the contact their sign-up made
    // may read a "ς" in its domain as "σ", and is the one they join.
    const other = o.src === "signup" ? spellings(o.email).map(cleanEmail)[1] : "";
    if (who && other && (await one("SELECT 1 FROM site_contacts WHERE site_slug = ? AND email = ?", [slug, other]))) who.email = other;
    seen.push([who, { source: o.src, at: Number(o.at) }]);
  }
  // Messages: who sent each is read from its fields here.
  const messages = await all<{ id: string; form: string; data: string; created_at: number }>(
    "SELECT id, form, data, created_at FROM site_messages WHERE site_slug = ? AND contact_id = '' ORDER BY created_at LIMIT 2000",
    [slug],
  );
  for (const m of messages) {
    let data: unknown = null;
    try {
      data = JSON.parse(m.data);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    seen.push([contactFromFields(data as Record<string, unknown>), { source: `form:${m.form}`, at: Number(m.created_at), messageId: m.id }]);
  }
  // 50 people to a write.
  let batch: InStatement[] = [];
  let count = 0;
  for (const [who, sighting] of seen) {
    if (!who) continue;
    batch.push(...contactStatements(slug, who, sighting, false));
    if (++count % 50 === 0) {
      await (await db()).batch(batch, "write");
      batch = [];
    }
  }
  if (batch.length) await (await db()).batch(batch, "write");
  await run("UPDATE sites SET contacts_filled = 1 WHERE slug = ?", [slug]);
}

/**
 * The people in an app's earlier sightings (rows gives e, the email; nm, the name; src, the source;
 * at, when; and k, to break ties; for the app's slug), one row each: their earliest sighting, with
 * the first name they gave and their latest time. Those already on the list are brought up to date,
 * then the others are added, earliest first, while there's room, so someone seen many times takes
 * one place and never keeps someone else off the list.
 */
async function fillFrom(slug: string, rows: string) {
  const insert = (which: "IN" | "NOT IN", limit: string) => `
    WITH seen AS (${rows}), people AS (
      SELECT e, src, at AS first_at, max(at) OVER (PARTITION BY e) AS last_at,
        first_value(nm) OVER (PARTITION BY e ORDER BY nm = '', at, k) AS nm,
        ROW_NUMBER() OVER (PARTITION BY e ORDER BY at, k) AS n
      FROM seen
    )
    INSERT INTO site_contacts (id, site_slug, email, name, source, first_seen, last_seen)
    SELECT lower(hex(randomblob(12))), s.slug, e, substr(nm, 1, ${MAX_NAME}), src, first_at, last_at
    FROM people JOIN sites s ON s.slug = ?
    WHERE n = 1 AND e ${which} (SELECT email FROM site_contacts WHERE site_slug = ? AND email <> '') ORDER BY first_at ${limit}
    ON CONFLICT(site_slug, email) WHERE email <> '' DO UPDATE SET ${MERGE}`;
  await run(insert("IN", ""), [slug, slug, slug]);
  // Up to 10,000 people at once: the app's count goes in the same write, rather than being kept up to
  // date one row at a time, and the next contact counts the list once again (see counted).
  await (await db()).batch(
    [
      { sql: "DELETE FROM site_contact_counts WHERE site_slug = ?", args: [slug] },
      { sql: insert("NOT IN", `LIMIT max(0, ${MAX_CONTACTS} - (SELECT COUNT(*) FROM site_contacts WHERE site_slug = ?))`), args: [slug, slug, slug, slug] },
    ],
    "write",
  );
}

const tagsOf = (json: string): string[] => {
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

function toContact(r: Row, stages: readonly Stage[]): Contact {
  const agreedAt = Number(r.consent_at);
  const unsubscribedAt = Number(r.unsubscribed_at);
  return {
    id: r.id,
    email: r.email,
    phone: r.phone,
    name: r.name,
    stage: stageOf(r.stage, stages),
    tags: tagsOf(r.tags),
    notes: r.notes,
    source: r.source,
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    consent: agreedAt > 0 ? { text: r.consent_text, at: agreedAt, form: r.consent_form, by: r.consent_by === "owner" ? "owner" : "form" } : null,
    unsubscribedAt,
    subscribed: agreedAt > 0 && !unsubscribedNow(r),
  };
}

/** The app's stages, in the owner's language (t). null when there's no such app. */
export async function contactStages(slug: string, t: Translate = english): Promise<Stage[] | null> {
  const site = await one<{ contact_stages: string }>("SELECT contact_stages FROM sites WHERE slug = ?", [slug]);
  return site ? stagesOf(site.contact_stages, t) : null;
}

// The stage each contact shows in, in SQL: their own, or the first stage when it's '' or gone.
const shownStage = (stages: readonly Stage[]) => ({
  sql: `CASE WHEN stage IN (${stages.map(() => "?").join(", ")}) THEN stage ELSE ? END`,
  args: [...stages.map((s) => s.id), stages[0].id],
});

export type ContactList = {
  contacts: Contact[];
  // Everyone on the list, and in each stage, counted (never just what was loaded).
  total: number;
  byStage: Record<string, number>;
  // How many a search found, in all and in each stage, when the server searched.
  matched?: number;
  matchedByStage?: Record<string, number>;
  stages: Stage[];
  max: number;
  // The whole list is here, so the page can search and lay out the board by itself.
  everything: boolean;
};

/**
 * The app's contacts for its owner, newest first. Up to SHOWN of them come at once, so a small list
 * is searched and laid out by the page itself. A bigger one is searched here (q: name, email, phone,
 * tags or notes), and otherwise comes as the newest PER_STAGE of each stage (mode "board") or the
 * newest SHOWN (mode "list").
 */
export async function listContacts(slug: string, t: Translate, { q = "", mode = "board" }: { q?: string; mode?: string } = {}): Promise<ContactList | null> {
  const stages = await contactStages(slug, t);
  if (!stages) return null;
  const stage = shownStage(stages);
  const counts = await all<{ s: string; n: number }>(`SELECT ${stage.sql} AS s, COUNT(*) AS n FROM site_contacts WHERE site_slug = ? GROUP BY s`, [
    ...stage.args,
    slug,
  ]);
  const byStage = Object.fromEntries(stages.map((s) => [s.id, 0]));
  for (const c of counts) byStage[c.s] = (byStage[c.s] ?? 0) + Number(c.n);
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  const base = { total, byStage, stages, max: MAX_CONTACTS };
  const list = (rows: Row[]) => rows.map((r) => toContact(r, stages));
  if (total <= SHOWN) {
    const rows = await all<Row>(`SELECT ${LISTED} FROM site_contacts WHERE site_slug = ? ORDER BY last_seen DESC, id LIMIT ?`, [slug, SHOWN]);
    return { ...base, contacts: list(rows), everything: true };
  }
  const words = q.trim().slice(0, 80);
  if (words) {
    // Searched here as the page searches a small list: SQLite's LIKE ignores the case of A to Z
    // only, so "иван" would miss Иван. Reading the list once costs no more rows than LIKE did.
    const rows = await all<Row>(`SELECT ${LISTED} FROM site_contacts WHERE site_slug = ? ORDER BY last_seen DESC, id LIMIT ?`, [slug, MAX_CONTACTS]);
    const found = list(rows).filter((c) => contactMatches(c, words));
    const matchedByStage = Object.fromEntries(stages.map((s) => [s.id, 0]));
    for (const c of found) matchedByStage[c.stage] += 1;
    return { ...base, contacts: found.slice(0, SHOWN), matched: found.length, matchedByStage, everything: false };
  }
  if (mode === "board") {
    const rows = await all<Row>(
      `SELECT ${LISTED} FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ${stage.sql} ORDER BY last_seen DESC, id) AS n FROM site_contacts WHERE site_slug = ?
       ) WHERE n <= ? ORDER BY last_seen DESC, id`,
      [...stage.args, slug, PER_STAGE],
    );
    return { ...base, contacts: list(rows), everything: false };
  }
  const rows = await all<Row>(`SELECT ${LISTED} FROM site_contacts WHERE site_slug = ? ORDER BY last_seen DESC, id LIMIT ?`, [slug, SHOWN]);
  return { ...base, contacts: list(rows), everything: false };
}

/** The link that unsubscribes a contact from an app's news: their id and a signature only Flash can make. */
export const unsubToken = (secret: string, slug: string, id: string) => `${id}.${hmac(secret, `unsub|${slug}|${id}`).digest("base64url").slice(0, 22)}`;
const unsubLink = (base: string, secret: string, slug: string, c: { id: string; email: string }) =>
  c.email && secret ? `${base}/u/${unsubToken(secret, slug, c.id)}` : "";

export type ContactDetail = {
  contact: Contact;
  member: { joined: number } | null;
  messages: { id: string; form: string; data: Record<string, unknown>; createdAt: number }[];
  messageCount: number;
  orders: { id: string; item: string; quantity: number; total: string; createdAt: number; done: boolean }[];
  orderCount: number;
  // Only for someone with an email address: news by email is what they can stop.
  unsubscribeLink: string;
  // Other contacts with their phone number: maybe the same person, maybe not, so never joined.
  samePhone: { id: string; name: string; email: string; phone: string }[];
};

const parsed = (json: string): Record<string, unknown> => {
  try {
    const data = JSON.parse(json);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
};

/** One contact for its owner: whether they're a member, their newest messages and orders, and their unsubscribe link. */
export async function contactDetail(slug: string, id: string, base: string, t: Translate = english): Promise<ContactDetail | null> {
  const stages = await contactStages(slug, t);
  const row = stages && (await one<Row>(`SELECT ${LISTED} FROM site_contacts WHERE site_slug = ? AND id = ?`, [slug, id]));
  if (!stages || !row) return null;
  const members = row.email ? await withAddress("site_users", slug, row.email) : null;
  const member = members
    ? await one<{ created_at: number }>(`SELECT created_at FROM site_users WHERE site_slug = ? AND ${members.sql} ORDER BY created_at LIMIT 1`, [slug, ...members.args])
    : null;
  const messages = await all<{ id: string; form: string; data: string; created_at: number }>(
    "SELECT id, form, data, created_at FROM site_messages WHERE site_slug = ? AND contact_id = ? ORDER BY created_at DESC LIMIT 5",
    [slug, id],
  );
  const messageCount = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_messages WHERE site_slug = ? AND contact_id = ?", [slug, id]))?.n ?? 0);
  type OrderRow = { session_id: string; item: string; quantity: number; amount: number; currency: string; created_at: number; done_at: number };
  const paid = row.email ? await withAddress("site_orders", slug, row.email) : null;
  const orders = paid
    ? await all<OrderRow>(
        `SELECT session_id, item, quantity, amount, currency, created_at, done_at FROM site_orders WHERE site_slug = ? AND ${paid.sql} ORDER BY created_at DESC LIMIT 5`,
        [slug, ...paid.args],
      )
    : [];
  const orderCount = paid ? Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM site_orders WHERE site_slug = ? AND ${paid.sql}`, [slug, ...paid.args]))?.n ?? 0) : 0;
  const samePhone = row.phone
    ? await all<{ id: string; name: string; email: string; phone: string }>(
        "SELECT id, name, email, phone FROM site_contacts WHERE site_slug = ? AND phone = ? AND phone <> '' AND id <> ? ORDER BY last_seen DESC, id LIMIT 10",
        [slug, row.phone, id],
      )
    : [];
  return {
    contact: toContact(row, stages),
    member: member ? { joined: Number(member.created_at) } : null,
    messages: messages.map((m) => ({ id: m.id, form: m.form, data: parsed(m.data), createdAt: Number(m.created_at) })),
    messageCount,
    orders: orders.map((o) => ({
      id: o.session_id,
      item: o.item,
      quantity: Number(o.quantity),
      total: formatMoney(Number(o.amount), o.currency),
      createdAt: Number(o.created_at),
      done: Boolean(Number(o.done_at)),
    })),
    orderCount,
    unsubscribeLink: unsubLink(base, row.email ? await siteSecret(slug) : "", slug, row),
    samePhone: samePhone.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone })),
  };
}

export type ContactPatch = { name?: unknown; stage?: unknown; tags?: unknown; notes?: unknown; phone?: unknown };

/**
 * The owner changes a contact's name, stage, tags, notes or phone number. "bad" for anything that
 * doesn't fit, "phone" for a phone number that isn't one. A form fills in a phone number nobody
 * proved is theirs, so the owner can correct it or clear it ("") on a contact with an email address;
 * someone known by their number alone keeps it, as an email contact keeps their address.
 */
export async function updateContact(
  slug: string,
  stages: readonly Stage[],
  id: string,
  patch: ContactPatch,
): Promise<"ok" | "bad" | "phone" | "missing"> {
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.phone !== undefined) {
    if (typeof patch.phone !== "string" || patch.phone.length > 100) return "bad";
    const phone = normalPhone(patch.phone);
    if (patch.phone.trim() && !phone) return "phone";
    const contact = await one<{ email: string }>("SELECT email FROM site_contacts WHERE site_slug = ? AND id = ?", [slug, id]);
    if (!contact) return "missing";
    if (!contact.email) return "bad";
    sets.push("phone = ?");
    args.push(phone);
  }
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.trim().length > MAX_NAME) return "bad";
    sets.push("name = ?");
    args.push(cleanName(patch.name));
  }
  if (patch.stage !== undefined) {
    if (typeof patch.stage !== "string" || !stages.some((s) => s.id === patch.stage)) return "bad";
    sets.push("stage = ?");
    args.push(patch.stage);
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.length > 50 || patch.tags.some((t) => typeof t !== "string" || t.length > 200)) return "bad";
    sets.push("tags = ?");
    args.push(JSON.stringify(cleanTags(patch.tags)));
  }
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== "string" || patch.notes.length > MAX_NOTES) return "bad";
    sets.push("notes = ?");
    args.push(patch.notes.trim());
  }
  if (!sets.length) return "bad";
  // The phone number changes only on a contact with an email address (see above), whatever happened meanwhile.
  const r = await run(`UPDATE site_contacts SET ${sets.join(", ")} WHERE site_slug = ? AND id = ?${patch.phone !== undefined ? " AND email <> ''" : ""}`, [
    ...args,
    slug,
    id,
  ]);
  return r.rowsAffected ? "ok" : "missing";
}

/**
 * The owner records that someone who unsubscribed asked them for news again, and how (note: "they
 * asked at the till", "they replied to my email"). A ticked box on a form can't do this (see
 * FORM_AGREES), as anyone can type someone else's address. The record says the owner made it, with
 * their note, and never claims wording the person saw. A later unsubscribe wins again. "bad" for a
 * note that's empty or too long, or someone who has no email or hasn't unsubscribed.
 */
export async function recordConsent(slug: string, id: string, note: unknown): Promise<"ok" | "bad" | "missing"> {
  const text = typeof note === "string" && note.length <= 2000 ? note.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > MAX_CONSENT_NOTE) return "bad";
  const r = await run(
    `UPDATE site_contacts SET consent_text = ?, consent_at = max(?, unsubscribed_at + 1), consent_ip = '', consent_channel = 'email', consent_form = '', consent_by = 'owner'
     WHERE site_slug = ? AND id = ? AND email <> '' AND ${UNSUBSCRIBED}`,
    [text, now(), slug, id],
  );
  if (r.rowsAffected) return "ok";
  return (await one("SELECT 1 FROM site_contacts WHERE site_slug = ? AND id = ?", [slug, id])) ? "bad" : "missing";
}

/**
 * The owner adds someone by hand: an email address, a phone number or both, and a name. Someone
 * already on the list stays one contact, and their id comes back. "full" at MAX_CONTACTS.
 */
export async function addContact(
  slug: string,
  input: { name?: unknown; email?: unknown; phone?: unknown },
): Promise<{ id: string } | { error: "none" | "email" | "phone" | "full" }> {
  const typed = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const [emailText, phoneText] = [typed(input.email), typed(input.phone)];
  if (!emailText && !phoneText) return { error: "none" };
  const email = cleanEmail(emailText);
  if (emailText && !email) return { error: "email" };
  const phone = normalPhone(phoneText);
  if (phoneText && !phone) return { error: "phone" };
  if (!email) {
    // The owner typing a number someone with an email address gave opens them, unless someone is
    // known by that number alone. Nothing about anyone moves.
    const known = await one<{ id: string; email: string }>(
      "SELECT id, email FROM site_contacts WHERE site_slug = ? AND phone = ? AND phone <> '' ORDER BY email = '' DESC, last_seen DESC, id LIMIT 1",
      [slug, phone],
    );
    if (known?.email) return { id: known.id };
  }
  const id = await noteContact(slug, { email, phone, name: cleanName(input.name) }, { source: "owner", at: now() });
  return id ? { id } : { error: "full" };
}

/** A stage id nobody uses yet: "s" and six letters or digits. */
function newStageId(taken: (id: string) => boolean): string {
  for (;;) {
    const id = `s${[...randomBytes(6)].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
    if (!taken(id)) return id;
  }
}

/**
 * The owner renames, adds, removes or reorders their stages (1 to MAX_STAGES, each with a name).
 * A stage keeps its id, so its people stay in it; people in a removed stage move to the first one,
 * and people never moved stay in the stage that was first. A standard stage still called by its
 * standard name keeps no name of its own, so it shows in whatever language the owner picks.
 */
export async function setStages(slug: string, t: Translate, input: unknown): Promise<{ stages: Stage[] } | { error: "count" | "name" } | null> {
  if (!Array.isArray(input) || input.length === 0) return { error: "name" };
  if (input.length > MAX_STAGES) return { error: "count" };
  const before = await contactStages(slug, t);
  if (!before) return null;
  const known = new Set([...before, ...DEFAULT_STAGES].map((s) => s.id));
  const saved: Stage[] = [];
  for (const entry of input) {
    const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
    const shown = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_STAGE_NAME) : "";
    if (!shown) return { error: "name" };
    const keep = typeof id === "string" && known.has(id) && !saved.some((s) => s.id === id);
    const stageId = keep ? id : newStageId((x) => known.has(x) || saved.some((s) => s.id === x));
    const standard = DEFAULT_STAGES.find((d) => d.id === stageId);
    saved.push({ id: stageId, name: standard && (shown === t(standard.name) || shown === standard.name) ? "" : shown });
  }
  const ids = saved.map((s) => s.id);
  const first = before[0].id;
  const statements: InStatement[] = [];
  // Nobody moved yet shows in the first stage; when that stage stays but isn't first any more, they stay in it.
  if (ids.includes(first) && ids[0] !== first) {
    statements.push({ sql: "UPDATE site_contacts SET stage = ? WHERE site_slug = ? AND stage = ''", args: [first, slug] });
  }
  statements.push({
    sql: `UPDATE site_contacts SET stage = '' WHERE site_slug = ? AND stage <> '' AND stage NOT IN (${ids.map(() => "?").join(", ")})`,
    args: [slug, ...ids],
  });
  statements.push({ sql: "UPDATE sites SET contact_stages = ? WHERE slug = ?", args: [JSON.stringify(saved), slug] });
  await (await db()).batch(statements, "write");
  return { stages: stagesOf(JSON.stringify(saved), t) };
}

/**
 * The owner deletes someone and what the app kept about them: their member account (with its
 * sign-ins, private records and files), the messages they sent, and the contact. Their orders stay
 * for the owner's books, without their name, email or address (Stripe keeps its own copy). Other
 * contacts with the same phone number stay: the details and the confirmation name them.
 */
export async function deleteContact(slug: string, id: string): Promise<boolean> {
  const contact = await one<{ email: string }>("SELECT email FROM site_contacts WHERE site_slug = ? AND id = ?", [slug, id]);
  if (!contact) return false;
  const paid = contact.email ? await withAddress("site_orders", slug, contact.email) : null;
  if (contact.email) {
    const members = await withAddress("site_users", slug, contact.email);
    for (const member of await all<{ id: string }>(`SELECT id FROM site_users WHERE site_slug = ? AND ${members.sql}`, [slug, ...members.args])) {
      await removeSiteUser(slug, member.id);
    }
  }
  await (await db()).batch(
    [
      { sql: "DELETE FROM site_messages WHERE site_slug = ? AND contact_id = ?", args: [slug, id] },
      ...(paid ? [{ sql: `UPDATE site_orders SET email = '', name = '', address = '' WHERE site_slug = ? AND ${paid.sql}`, args: [slug, ...paid.args] }] : []),
      { sql: "DELETE FROM site_contacts WHERE site_slug = ? AND id = ?", args: [slug, id] },
    ],
    "write",
  );
  return true;
}

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Rows from a query, newest first, while they fit in what's left of budget (bytes); what they took is subtracted. */
async function within<T>(sql: string, args: InValue[], toItem: (row: Record<string, unknown>) => T, budget: { left: number }) {
  const items: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const rows = await all<Record<string, unknown>>(`${sql} LIMIT 100 OFFSET ?`, [...args, offset]);
    for (const row of rows) {
      const item = toItem(row);
      const bytes = size(item) + 1;
      if (bytes > budget.left) return { items, full: true };
      budget.left -= bytes;
      items.push(item);
    }
    if (rows.length < 100) return { items, full: false };
  }
}

/**
 * Everything the app keeps about one contact, as JSON for the owner to give them: the contact with
 * what they agreed to (and the hashed address), their member account (never its password), their
 * messages and orders, their private records and their files' details. It stays under 4 MB: the
 * newest messages and private records that fit, with how many there are when some are left out.
 */
export async function exportContact(slug: string, id: string, base: string, t: Translate = english): Promise<Record<string, unknown> | null> {
  const stages = await contactStages(slug, t);
  const row = stages && (await one<Row>("SELECT * FROM site_contacts WHERE site_slug = ? AND id = ?", [slug, id]));
  if (!stages || !row) return null;
  const site = await one<{ title: string }>("SELECT title FROM sites WHERE slug = ?", [slug]);
  const secret = await siteSecret(slug);
  const members = row.email ? await withAddress("site_users", slug, row.email) : null;
  const member = members
    ? await one<{ id: string; email: string; name: string; created_at: number }>(
        `SELECT id, email, name, created_at FROM site_users WHERE site_slug = ? AND ${members.sql} ORDER BY created_at LIMIT 1`,
        [slug, ...members.args],
      )
    : null;
  const agreedAt = Number(row.consent_at);
  const out: Record<string, unknown> = {
    exportedAt: iso(now()),
    app: { title: site?.title ?? "", address: `${base}/p/${slug}` },
    contact: {
      id: row.id,
      email: row.email,
      phone: row.phone,
      name: row.name,
      stage: stages.find((s) => s.id === stageOf(row.stage, stages))?.name ?? "",
      tags: tagsOf(row.tags),
      notes: row.notes,
      source: sourceLabel(row.source, t),
      firstSeen: iso(Number(row.first_seen)),
      lastSeen: iso(Number(row.last_seen)),
      consent: !agreedAt
        ? null
        : row.consent_by === "owner"
          ? { recordedBy: "owner", note: row.consent_text, at: iso(agreedAt), channel: row.consent_channel }
          : { text: row.consent_text, at: iso(agreedAt), form: row.consent_form, channel: row.consent_channel, ipHash: row.consent_ip },
      unsubscribedAt: iso(Number(row.unsubscribed_at)),
      // As the list says it (see unsubscribedNow), so a form's agreement dated after their
      // unsubscribe (#114 kept those) never reads as them agreeing again.
      subscribed: agreedAt > 0 && !unsubscribedNow(row),
      unsubscribeLink: unsubLink(base, secret, slug, row),
    },
    member: member ? { email: member.email, name: member.name, joined: iso(Number(member.created_at)) } : null,
  };
  const paid = row.email ? await withAddress("site_orders", slug, row.email) : null;
  const orders = paid
    ? await all<{ item: string; quantity: number; amount: number; currency: string; email: string; name: string; address: string; created_at: number; done_at: number }>(
        `SELECT item, quantity, amount, currency, email, name, address, created_at, done_at FROM site_orders WHERE site_slug = ? AND ${paid.sql} ORDER BY created_at DESC LIMIT 1000`,
        [slug, ...paid.args],
      )
    : [];
  out.orders = orders.map((o) => ({
    item: o.item,
    quantity: Number(o.quantity),
    total: formatMoney(Number(o.amount), o.currency),
    email: o.email,
    name: o.name,
    address: o.address,
    createdAt: iso(Number(o.created_at)),
    done: Boolean(Number(o.done_at)),
  }));
  const files = member
    ? await all<{ id: string; name: string; mime: string; size: number; created_at: number }>(
        "SELECT id, name, mime, size, created_at FROM site_uploads WHERE site_slug = ? AND owner = ? ORDER BY created_at DESC LIMIT 1000",
        [slug, member.id],
      )
    : [];
  out.files = files.map((f) => ({ name: f.name, mime: f.mime, size: Number(f.size), createdAt: iso(Number(f.created_at)), url: `${base}/api/sites/${slug}/files/${f.id}` }));
  const budget = { left: EXPORT_BYTES - size(out) };
  const messageTotal = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_messages WHERE site_slug = ? AND contact_id = ?", [slug, id]))?.n ?? 0);
  const messages = await within(
    "SELECT form, data, created_at FROM site_messages WHERE site_slug = ? AND contact_id = ? ORDER BY created_at DESC, id",
    [slug, id],
    (m) => ({ form: m.form, data: parsed(String(m.data)), createdAt: iso(Number(m.created_at)) }),
    budget,
  );
  out.messages = messages.items;
  if (messages.full) out.messagesCut = { included: messages.items.length, total: messageTotal };
  if (member) {
    const recordTotal = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_records WHERE site_slug = ? AND owner = ?", [slug, member.id]))?.n ?? 0);
    const records = await within(
      "SELECT collection, data, created_at, updated_at FROM site_records WHERE site_slug = ? AND owner = ? ORDER BY created_at DESC, id",
      [slug, member.id],
      (r) => ({ collection: r.collection, data: parsed(String(r.data)), createdAt: iso(Number(r.created_at)), updatedAt: iso(Number(r.updated_at)) }),
      budget,
    );
    out.privateRecords = records.items;
    if (records.full) out.privateRecordsCut = { included: records.items.length, total: recordTotal };
  } else out.privateRecords = [];
  return out;
}

/**
 * The whole list as a CSV file for the owner, newest first, with each column named in their
 * language. A reply can't be much over 4 MB, so the rows stop before maxBytes, and included says
 * how many made it.
 */
export async function contactCsv(slug: string, t: Translate, base: string, maxBytes = 4_000_000): Promise<{ csv: string; included: number; total: number }> {
  const stages = (await contactStages(slug, t)) ?? [];
  const rows = stages.length
    ? await all<Row>("SELECT * FROM site_contacts WHERE site_slug = ? ORDER BY last_seen DESC, id LIMIT ?", [slug, MAX_CONTACTS])
    : [];
  const secret = rows.some((r) => r.email) ? await siteSecret(slug) : "";
  const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");
  const header = [
    t("Name"),
    t("Email"),
    t("Phone"),
    t("Stage"),
    t("Tags"),
    t("Notes"),
    t("Source"),
    t("First seen"),
    t("Last seen"),
    t("Agreed to news"),
    t("Agreed on"),
    t("Wording they saw"),
    t("Agreed on form"),
    t("Internet address (scrambled)"),
    t("Unsubscribed on"),
    t("Unsubscribe link"),
  ];
  const lines: unknown[][] = [];
  let bytes = Buffer.byteLength(toCsv([header]));
  for (const r of rows) {
    const c = toContact(r, stages);
    const line = [
      c.name,
      c.email,
      c.phone,
      stages.find((s) => s.id === c.stage)?.name ?? "",
      c.tags.join(", "),
      c.notes,
      sourceLabel(c.source, t),
      when(c.firstSeen),
      when(c.lastSeen),
      c.subscribed ? t("Yes") : t("No"),
      when(c.consent?.at ?? 0),
      c.consent?.by === "owner" ? t("Recorded by you: {note}", { note: c.consent.text }) : (c.consent?.text ?? ""),
      c.consent?.form ?? "",
      c.consent ? (r.consent_ip ?? "") : "",
      when(c.unsubscribedAt),
      unsubLink(base, secret, slug, c),
    ];
    // Each row's own size, without the 3-byte mark toCsv starts every file with.
    const lineBytes = Buffer.byteLength(toCsv([line])) - 3;
    if (bytes + lineBytes > maxBytes) break;
    bytes += lineBytes;
    lines.push(line);
  }
  return { csv: toCsv([header, ...lines]), included: lines.length, total: rows.length };
}

const TOKEN = /^([\w-]{16,24})\.([\w-]{22})$/;

/** Whose unsubscribe link this is: the app (its slug and title) and whether they're unsubscribed now. null for a link that doesn't work. Reads only. */
export async function tokenContact(token: string): Promise<{ id: string; slug: string; title: string; unsubscribed: boolean } | null> {
  const parts = TOKEN.exec(token);
  if (!parts) return null;
  const row = await one<{ id: string; site_slug: string; consent_at: number; consent_by: string; unsubscribed_at: number; title: string; contact_secret: string }>(
    `SELECT c.id, c.site_slug, c.consent_at, c.consent_by, c.unsubscribed_at, s.title, s.contact_secret
     FROM site_contacts c JOIN sites s ON s.slug = c.site_slug WHERE c.id = ?`,
    [parts[1]],
  );
  if (!row || !row.contact_secret) return null;
  const expected = Buffer.from(unsubToken(row.contact_secret, row.site_slug, row.id).slice(row.id.length + 1));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { id: row.id, slug: row.site_slug, title: row.title, unsubscribed: unsubscribedNow(row) };
}

/**
 * Someone stops an app's news with their link. The time is kept, and stays: a box ticked on a form
 * afterwards doesn't undo it (see FORM_AGREES), the owner recording that they asked for news again
 * counts from then (recordConsent), and a later unsubscribe is kept again. It holds as well for the
 * app's other contacts with the same mailbox (see sameMailbox), such as one with a +tag or one #114
 * kept in another spelling, which may have agreed before. false for a link that doesn't work.
 */
export async function unsubscribe(token: string): Promise<boolean> {
  const found = await tokenContact(token);
  if (!found) return false;
  const at = now();
  const done = await run(`UPDATE site_contacts SET unsubscribed_at = ? WHERE id = ? AND NOT (${UNSUBSCRIBED}) RETURNING email`, [at, found.id]);
  // Only when they weren't unsubscribed already, as the link used again changes nothing.
  const email = (done.rows[0] as unknown as { email: string } | undefined)?.email;
  const others = email ? (await sameMailbox(found.slug, email, `NOT (${UNSUBSCRIBED})`)).map((c) => c.id) : [];
  if (others.length) {
    await run(`UPDATE site_contacts SET unsubscribed_at = ? WHERE site_slug = ? AND id IN (${others.map(() => "?").join(", ")}) AND NOT (${UNSUBSCRIBED})`, [
      at,
      found.slug,
      ...others,
    ]);
  }
  return true;
}
