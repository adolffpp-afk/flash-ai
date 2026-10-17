/*
 * Each app's contact list (see server/contacts.ts): who someone is from a form's fields, the
 * owner's pipeline stages, and the limits on what the owner types. Pure, with no server imports:
 * the server, My websites & apps and the tests all use it.
 */
import { msg, type Translate } from "./i18n.ts";

/**
 * An email address, as sign-up forms check it: after the @, a domain of letters, digits, dots and
 * hyphens in any script, so nothing like "?bcc=…" can ride along on it. Check the length first:
 * the pattern is slow on very long text.
 */
export const EMAIL = /^[^\s@]+@[\p{L}\p{M}\p{N}.-]+\.[\p{L}\p{M}\p{N}-]{2,}$/u;

export const MAX_CONTACTS = 10_000;
export const MAX_EMAIL = 160;
export const MAX_NAME = 80;
export const MAX_TAGS = 10;
export const MAX_TAG = 30;
export const MAX_NOTES = 1000;
export const MAX_STAGES = 12;
export const MAX_STAGE_NAME = 40;
export const STAGE_ID = /^[a-z0-9]{1,12}$/;

/** Who a contact is: their email (lowercased) and phone ("+digits" or "digits"), either may be "", and their name. */
export type Who = { email: string; phone: string; name: string };
export type Stage = { id: string; name: string };

/**
 * The stages every list starts with. A stage saved with these ids and no name of its own shows these,
 * translated. The first has its own phrase: "New" is an unread message's, worded for a message.
 */
export const DEFAULT_STAGES: readonly Stage[] = [
  { id: "new", name: msg("New contact") },
  { id: "contacted", name: msg("Contacted") },
  { id: "won", name: msg("Won") },
  { id: "lost", name: msg("Lost") },
];

/** Text with every run of spaces made one space, trimmed. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** An email address someone typed, lowercased, or "". */
export function cleanEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : "";
}

// What a mailto: link takes as it is; anything else in an address is percent-encoded.
const mailtoPart = (text: string) => text.replace(/[^\w.~!$'*+-]/gu, encodeURIComponent);

/**
 * A mailto: link that writes to this address and no one else: a "?", "#", "%" or "," in it (an
 * address may have them before the @) can't add a Bcc, a subject or another recipient.
 */
export function mailtoLink(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? `mailto:${mailtoPart(email)}` : `mailto:${mailtoPart(email.slice(0, at))}@${mailtoPart(email.slice(at + 1))}`;
}

/**
 * A phone number as "+" and digits when it starts with + or 00, else digits only, or "" when it
 * isn't one: 7 to 15 digits, with only spaces, dots, dashes, slashes and brackets between them.
 */
export function normalPhone(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > 40 || !/^\+?[\d\s().\-/]+$/.test(text)) return "";
  let digits = text.replace(/\D/g, "");
  let plus = text.startsWith("+");
  if (!plus && digits.startsWith("00")) {
    plus = true;
    digits = digits.slice(2);
  }
  return digits.length >= 7 && digits.length <= 15 ? `${plus ? "+" : ""}${digits}` : "";
}

/** A name someone gave, on one line and at most MAX_NAME characters. */
export const cleanName = (value: unknown) => (typeof value === "string" ? oneLine(value).slice(0, MAX_NAME) : "");

/** Who someone is from what they gave (a sign-up, a paid order, the owner's Add contact), or null with no email and no phone. */
export function cleanContact(raw: { email?: unknown; phone?: unknown; name?: unknown }): Who | null {
  const who = { email: cleanEmail(raw.email), phone: normalPhone(raw.phone), name: cleanName(raw.name) };
  return who.email || who.phone ? who : null;
}

// A form field's name with accents taken off, as lowercase words ("userEmail" is "user email") and
// squashed together ("first_name" is "firstname").
const plainKey = (key: string) => key.normalize("NFD").replace(/[̀-ͯ]/g, "");
const wordsOf = (key: string) => plainKey(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
const squashed = (key: string) => plainKey(key).toLowerCase().replace(/[^a-z0-9]/g, "");

const PHONE_WORDS = new Set(["phone", "mobile", "cell", "cellphone", "celular", "movil", "whatsapp", "tel", "telephone", "telefon", "telefono", "telefone", "handy"]);
const FULL_NAME = new Set(["name", "fullname", "yourname", "customername", "contactname", "nombre"]);
const FIRST_NAME = new Set(["firstname", "first", "prenom", "givenname", "vorname"]);
const LAST_NAME = new Set(["lastname", "last", "surname", "familyname", "nachname", "apellido", "apellidos"]);

/**
 * Who sent a form, from its fields: the email (a field named email, then any field named like an
 * email, then the first value that is an email address), the phone number (a field named like a
 * phone, so "hotel" isn't one) and the name. Only text values count. null when there's no email
 * and no phone.
 */
export function contactFromFields(data: Record<string, unknown>): Who | null {
  const fields = Object.entries(data).filter((e): e is [string, string] => typeof e[1] === "string");
  const firstOf = (match: (key: string) => boolean, clean: (value: string) => string) => {
    for (const [key, value] of fields) {
      if (!match(key)) continue;
      const found = clean(value);
      if (found) return found;
    }
    return "";
  };
  const email =
    firstOf((k) => squashed(k) === "email", cleanEmail) ||
    firstOf((k) => /e-?mail|correo|courriel/i.test(plainKey(k)), cleanEmail) ||
    firstOf(() => true, cleanEmail);
  // "WhatsApp" is the words "whats" and "app", so the name squashed together counts too.
  const phone = firstOf((k) => wordsOf(k).some((w) => PHONE_WORDS.has(w)) || /phone|whatsapp/.test(squashed(k)), normalPhone);
  const named = (names: Set<string>) => firstOf((k) => names.has(squashed(k)), cleanName);
  const first = named(FIRST_NAME);
  const nom = named(new Set(["nom"]));
  // "Nom" is the family name on a form that also asks for a "prénom", else the whole name.
  const name = named(FULL_NAME) || (first ? cleanName(`${first} ${named(LAST_NAME) || nom}`) : nom);
  return email || phone ? { email, phone, name } : null;
}

/** Tags the owner typed: trimmed, without empty ones or the same tag twice (whatever its case), at most MAX_TAGS. */
export function cleanTags(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const tags: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const tag = oneLine(raw).slice(0, MAX_TAG);
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** The app's stages from what it saved (sites.contact_stages), or New, Contacted, Won, Lost. */
export function stagesOf(saved: string, t: Translate): Stage[] {
  const defaults = () => DEFAULT_STAGES.map((s) => ({ id: s.id, name: t(s.name) }));
  let list: unknown = null;
  try {
    list = saved ? JSON.parse(saved) : null;
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return defaults();
  const stages: Stage[] = [];
  for (const s of list.slice(0, MAX_STAGES)) {
    const { id, name } = (s ?? {}) as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || !STAGE_ID.test(id) || typeof name !== "string" || stages.some((x) => x.id === id)) continue;
    const standard = DEFAULT_STAGES.find((d) => d.id === id);
    const shown = oneLine(name).slice(0, MAX_STAGE_NAME) || (standard ? t(standard.name) : "");
    if (shown) stages.push({ id, name: shown });
  }
  return stages.length ? stages : defaults();
}

/** The stage a contact shows in: their own, or the first stage when it's "" or no longer there. */
export const stageOf = (stage: string, stages: readonly Stage[]) => (stages.some((s) => s.id === stage) ? stage : stages[0].id);

/**
 * What to say when a request from My websites & apps › Contacts failed: the server's own words
 * (they come with the answer's status), or fallback when no answer came at all, such as the
 * browser's "Failed to fetch" offline, which is in the browser's language rather than Flash's.
 */
export const failedText = (err: unknown, fallback: string) => (err instanceof Error && "status" in err && err.message ? err.message : fallback);

/**
 * The stage a phone shows of the board, where one stage shows at a time: the one the owner picked
 * (the first when they picked none, or one that's gone), or, for a search they picked it before
 * (searchedSince), the first with matches when theirs has none, so matches never hide behind a
 * stage. count is how many show in each.
 */
export function phoneStage(ids: readonly string[], picked: string, searchedSince: boolean, count: (id: string) => number): string {
  const chosen = ids.includes(picked) ? picked : ids[0];
  if (!searchedSince || count(chosen) > 0) return chosen;
  return ids.find((id) => count(id) > 0) ?? chosen;
}

/** Whether a contact matches what the owner searched for: their name, email, phone, tags or notes, without regard to case. */
export function contactMatches(c: { name: string; email: string; phone: string; tags: string[]; notes: string }, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const digits = /^[+\d\s().\-/]+$/.test(q) ? q.replace(/\D/g, "") : "";
  if (digits.length >= 3 && c.phone.includes(digits)) return true;
  return [c.name, c.email, c.phone, c.tags.join(" "), c.notes].some((text) => text.toLowerCase().includes(q));
}

/** What the owner can change on a contact's page, as typed. */
export type ContactForm = { name: string; stage: string; tags: string; notes: string; phone: string };

/** Whether two versions of a contact's form differ once cleaned as the server cleans them (so spaces alone change nothing). */
export function formChanged(a: ContactForm, b: ContactForm): boolean {
  const cleaned = (f: ContactForm) => JSON.stringify([cleanName(f.name), f.stage, cleanTags(f.tags), f.notes.trim(), normalPhone(f.phone) || f.phone.trim()]);
  return cleaned(a) !== cleaned(b);
}

/** A date for the owner: "Mar 3" this year, else "Mar 3, 2025", with the time when withTime. */
export function dateText(when: number, locale: string, withTime = false, today = Date.now()): string {
  const date = new Date(when);
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(today).getFullYear() && { year: "numeric" }),
    ...(withTime && { hour: "numeric", minute: "2-digit" }),
  });
}

/** Where a contact came from, in words: a form, a sign-up, a paid order or the owner. */
export function sourceLabel(source: string, t: Translate): string {
  if (source.startsWith("form:")) return t("Form: {form}", { form: source.slice(5) });
  if (source.startsWith("order:")) return source.length > 6 ? t("Bought {item}", { item: source.slice(6) }) : t("Paid order");
  if (source === "signup") return t("Signed up");
  if (source === "owner") return t("Added by you");
  return source;
}

/**
 * A page's words, for finding a phrase in it: without tags, with character references read and
 * other named ones (&rsquo;, &nbsp;) as a space, lowercased, and every run of anything that isn't a
 * letter or a digit as one space. Read in one pass, so no page can make it slow.
 */
export function pageWords(text: string): string {
  let plain = "";
  for (let i = 0; i < text.length; ) {
    let open = text.indexOf("<", i);
    // A "<" that can't start a tag ("ages <12") is text, as browsers read it.
    while (open !== -1 && !/[a-z/!?]/i.test(text[open + 1] ?? "")) open = text.indexOf("<", open + 1);
    if (open === -1) {
      plain += text.slice(i);
      break;
    }
    plain += text.slice(i, open);
    const close = text.indexOf(">", open + 1);
    if (close === -1) {
      plain += text.slice(open);
      break;
    }
    plain += " ";
    i = close + 1;
  }
  return plain
    .replace(/&#(x[0-9a-f]{1,6}|\d{1,7});/gi, (_all, n: string) => {
      const code = n[0] === "x" || n[0] === "X" ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&[a-z][a-z0-9]{0,31};/gi, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether a page shows a phrase, word for word, whatever its markup, spacing, quotes and case. */
export function pageHas(html: string, text: string): boolean {
  const words = pageWords(text);
  return words !== "" && ` ${pageWords(html)} `.includes(` ${words} `);
}
