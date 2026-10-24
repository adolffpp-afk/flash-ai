import { now } from "./db.ts";
import { countOf, giveBackOne, giveBackSome, overLimit, takeOne, takeSome } from "./limits.ts";
import { afterSentence } from "../i18n.ts";
import { BRAND_NAME, SUPPORT_EMAIL } from "../product.ts";

/*
 * Sends account emails (verification, password reset and sign-in links) through Resend when RESEND_API_KEY is
 * set. Without it, email verification is off and password reset is unavailable, unless
 * FLASH_DEMO_EMAILS=true, which shows the link on screen for testing (never in production).
 */
const RESEND_API = process.env.RESEND_BASE_URL || "https://api.resend.com";

/*
 * How many emails Flash sends a day. Resend's free plan sends 100 a day (3,000 a month), shared by
 * every email Flash sends, so published apps' form messages must never use up what sign-in links,
 * email confirmations and password resets need. On a bigger Resend plan, raise the numbers here.
 */
export const EMAIL_BUDGET = {
  // Everything Flash may send in a day (counted from midnight UTC): the email provider's allowance.
  perDay: 100,
  // Always left for sign-in links, email confirmations and password resets: other emails (app
  // form messages, orders, team invites) stop once only this many of the day's emails are left.
  keptForAccounts: 60,
  // Form messages one person's apps may email them in a day, across all their apps. Every message
  // is still saved in My websites & apps.
  perOwner: 10,
  // Sign-in links and confirmations to addresses with no confirmed account yet, a day. Anyone can
  // ask for these, so they get a share of their own and can't use up what members need.
  forNewAddresses: 25,
  // Emails one network may ask Flash to send to anyone a day, while signed out (sign-in links,
  // sign-ups and password resets together).
  perNetwork: 15,
  // Emails telling Flash's admins about new reports, a day (and one per reported item an hour, see
  // reports.ts). Anyone can report, so these have a share of their own. One email goes to every
  // admin at once and counts once here (once per admin in the day's total). Every report is still
  // listed in /admin > Reports.
  reports: 10,
  // Low-credit and out-of-credits emails, a day (see low-balance.ts): someone's credits falling below
  // the level they picked, or running out. They come out of what app emails and invites share, never
  // what sign-in emails keep, and stop at this many: one that can't go out waits for a later day, and
  // Flash still shows it in the app.
  alerts: 10,
  // "Your app's AI is out of credits" emails to app owners, a day (see low-balance.ts), the same way.
  // Visitors set these off, so they have a share of their own and never use up the low-credit emails'.
  appAiAlerts: 5,
  // Automations' results emailed to their owners, a day, for everyone (see automation-alerts.ts, which
  // also keeps each account to a few a day), the same way: one that can't go out is still in Flash.
  automations: 10,
};

const DAY = 86_400_000;

/**
 * What an email is, which decides whether today's budget lets it go out:
 * - "account": email confirmations, password resets and sign-in links for confirmed accounts.
 *   Always sent.
 * - "new": a sign-in link or confirmation to an address with no confirmed account yet. Anyone can
 *   ask for these, so they stop at EMAIL_BUDGET.forNewAddresses a day.
 * - "other": team invitations and shop orders, sent while the day's budget lasts. Each needs a
 *   paid plan or a real payment, so nobody can send many for free.
 * - { owner }: a published app's form message to the user who owns the app. Anyone can send
 *   forms, so these also stop at the owner's own daily cap.
 * - "report": a new report, to Flash's admins. Anyone can report, so these also stop at
 *   EMAIL_BUDGET.reports a day.
 * - "alert": a low-credit or out-of-credits email (see low-balance.ts). These also stop at
 *   EMAIL_BUDGET.alerts a day.
 * - "app-ai": an "app's AI is out of credits" email (low-balance.ts). These also stop at
 *   EMAIL_BUDGET.appAiAlerts a day.
 * - "automation": an automation's result, to its owner (automation-alerts.ts). These also stop at
 *   EMAIL_BUDGET.automations a day.
 */
export type EmailKind = "account" | "new" | "other" | "report" | "alert" | "app-ai" | "automation" | { owner: string };

/** The places an email took of today's emails (see withinBudget), given back when it didn't go. */
type Taken = { key: string; until: number; count: number }[];

/**
 * Whether today's budget lets an email of this kind go out, counting it when it does: null when it
 * doesn't, else the places it took. Account emails and the rest are counted apart, so sign-in emails
 * never use up what orders and invites get, and those never use up what sign-in emails keep. The
 * day's totals count each recipient, so an email to several never takes more than the provider allows.
 */
async function withinBudget(kind: EmailKind, recipients: number): Promise<Taken | null> {
  const day = new Date(now()).toISOString().slice(0, 10);
  const accounts = `email-day-acct:${day}`;
  const others = `email-day:${day}`;
  if (kind === "new" && (await overLimit(`email-new:${day}`, EMAIL_BUDGET.forNewAddresses, DAY))) {
    console.warn("[flash] today's sign-in emails to new addresses are used up");
    return null;
  }
  if (kind === "account" || kind === "new") {
    await overLimit(accounts, Infinity, DAY, recipients);
    return [];
  }
  // Checked first, so one person's busy apps (or a flood of reports) can't use up everyone else's share.
  if (typeof kind === "object" && (await overLimit(`email-owner:${kind.owner}`, EMAIL_BUDGET.perOwner, DAY))) return null;
  if (kind === "report" && (await overLimit(`email-report:${day}`, EMAIL_BUDGET.reports, DAY))) return null;
  // An alert's own share, then the day's shared emails, each taken in one statement, so emails at the
  // same moment get every place there is (and no more), and one refused takes nothing: an alert's
  // place is handed back when the shared emails then refuse it.
  const share =
    kind === "alert"
      ? { key: `email-alert:${day}`, max: EMAIL_BUDGET.alerts }
      : kind === "app-ai"
        ? { key: `email-app-ai:${day}`, max: EMAIL_BUDGET.appAiAlerts }
        : kind === "automation"
          ? { key: `email-automation:${day}`, max: EMAIL_BUDGET.automations }
          : null;
  const shareUntil = share ? await takeOne(share.key, share.max, DAY) : null;
  if (share && shareUntil === null) return null;
  const full = (await countOf(accounts)) + (await countOf(others)) + recipients > EMAIL_BUDGET.perDay;
  const until = full ? null : await takeSome(others, EMAIL_BUDGET.perDay - EMAIL_BUDGET.keptForAccounts, DAY, recipients);
  if (until === null) {
    if (share && shareUntil !== null) await giveBackOne([[share.key, shareUntil]]);
    console.warn("[flash] today's emails for apps and invites are used up; raise EMAIL_BUDGET in email.ts on a bigger email plan");
    return null;
  }
  return [...(share && shareUntil !== null ? [{ key: share.key, until: shareUntil, count: 1 }] : []), { key: others, until, count: recipients }];
}

/**
 * An email that didn't go: the provider refused it (status, its answer's), or it stopped before it
 * was sent (0). An email whose sending got no answer (a time-out, a lost connection) throws as it is:
 * it may have gone.
 */
export class EmailNotSent extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Counts one signed-out request to email someone; true when this network has asked too often today. */
export const tooManyFromNetwork = (ip: string) => overLimit(`email-ip:${ip}`, EMAIL_BUDGET.perNetwork, DAY);

export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY);
export const demoEmails = () => !emailEnabled() && process.env.FLASH_DEMO_EMAILS === "true";
/** Whether new accounts must confirm their email before getting free credits. */
export const verificationRequired = () => emailEnabled() || demoEmails();

const FROM = () => process.env.FLASH_EMAIL_FROM || `${BRAND_NAME} <hello@flash-app.dev>`;
// Where replies to Flash's own emails go (FLASH_CONTACT_EMAIL, as on the legal pages, or support@).
const SUPPORT = process.env.FLASH_CONTACT_EMAIL || SUPPORT_EMAIL;

const IGNORE = "If you didn't ask for this, you can ignore this email.";

/**
 * The words of an email's frame, as text, in the reader's language when the email is (see
 * automationResult), else English; help names the support address as {email}.
 */
type Frame = { lang?: string; rtl?: boolean; paste?: string; help?: string };

/** An email's page: body is one paragraph's HTML, or (blocks) paragraphs and lists already made with block(). */
function layout(heading: string, body: string | { blocks: string }, button: string, link: string, footer = IGNORE, frame: Frame = {}): string {
  const support = `<a href="mailto:${SUPPORT}" style="color:#047857">${SUPPORT}</a>`;
  // On the card and body too: Gmail and others drop the <html> element and keep only what's inside.
  const dir = frame.lang ? ` lang="${escapeHtml(frame.lang)}" dir="${frame.rtl ? "rtl" : "ltr"}"` : "";
  return `<!doctype html><html${dir}><head><meta charset="utf-8"></head><body${dir} style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
<div${dir} style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;padding:32px;overflow-wrap:anywhere;word-break:break-word">
<div style="font-size:20px;font-weight:700;color:#047857">Flash ∞ AI</div>
<h1${frame.lang ? ' dir="auto"' : ""} style="font-size:20px;margin:24px 0 8px">${heading}</h1>
${typeof body === "string" ? `<p style="color:#52525b;line-height:1.5">${body}</p>` : body.blocks}
<p style="margin:24px 0"><a href="${link}" style="background:#047857;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${button}</a></p>
<p style="color:#a1a1aa;font-size:12px;line-height:1.5">${escapeHtml(frame.paste ?? "Or paste this link into your browser:")}<br>${link}</p>
<p style="color:#a1a1aa;font-size:12px">${footer}</p>
<p style="color:#a1a1aa;font-size:12px">${escapeHtml(frame.help ?? "Need help with Flash? Write to {email}.").replace("{email}", support)}</p>
</div></body></html>`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/*
 * The low-credit emails' words (see low-balance.ts). LOW_CREDITS_LINE is the wording Flash's owner
 * approved, which the app shows too (the bell and Home, in each language).
 */
export const LOW_CREDITS_LINE =
  "Your Flash credits are running low. Your apps and websites keep running, but they only get new updates while you have credits. Top up to keep them updating.";
const ALERTS_OFF = "You get this because low-credit emails are on. To stop them, open Credits in Flash and untick “Email me when my credits run low”.";
export const OUT_OF_CREDITS_HEADING = "Your Flash credits have run out: top up to keep your apps updating";
export const OUT_OF_CREDITS_LINE = "Your Flash account has run out of credits.";

/** What the account can still use on free models with no credits (see free.ts), or null when it can't (no free models set up, or an email not confirmed yet). */
export type FreeUse = { chats: number; images: number } | null;
/**
 * The paid tools the server has set up (engineStatus in status.ts). One that isn't set up says it's
 * coming soon however many credits there are, so it waits for no top-up: the lists leave it out.
 */
export type LiveTools = { app: boolean; text: boolean; image: boolean; video: boolean; music: boolean; voice: boolean };
const ALL_LIVE: LiveTools = { app: true, text: true, image: true, video: true, music: true, voice: true };
/** Who the credit emails are to: the name Flash calls them (none: no greeting), what free models give them, and what the server has set up (all of it when not given). */
export type CreditEmailTo = { name?: string | null; free?: FreeUse; live?: LiveTools };

/*
 * What keeps working with no credits, and what waits for credits, as the credit emails list them.
 * Every line is true of Flash at 0 credits, whatever the person asks (check the code it names when
 * Flash changes):
 * - Published apps and websites are served (serve-site.ts), and their forms (inbox.ts), sign-ins
 *   (site-auth.ts) and shop orders (shop.ts, paid to the owner's Stripe) go on, none of them using credits.
 * - Free daily chats: chat, writing, code and translation go to a free model when the balance doesn't
 *   cover a request (the chat route, freeEligible and FREE_DAILY_CHATS in free.ts), for a confirmed
 *   email; pictures too, up to FREE_DAILY_IMAGES, when free pictures are set up. Only for an engine
 *   that is set up (live): the chat route's free lane is for those (goesFree).
 * - Waiting: Flash building or changing an app (the app engine has no free model; changes the owner
 *   makes in an app's code, and publishing them, use no credits: publishSite in sites.ts), a reply on
 *   a paid level, pictures on paid models, videos, music and voiceovers (each holds credits first:
 *   charge() in credits.ts, which refuses with none), and an app's AI answering visitors (site-ai.ts
 *   refuses when the owner's credits don't pay for an answer). Only what the server has set up (live):
 *   the rest says it's coming soon, credits or not.
 */
export function creditLists(free: FreeUse = null, live: LiveTools = ALL_LIVE): { working: string[]; waiting: string[] } {
  const chats = live.text && free && free.chats > 0 ? free.chats : 0;
  const images = chats && live.image && free && free.images > 0 ? free.images : 0;
  const media = [
    live.image && (images ? "pictures on paid models" : "pictures"),
    live.video && "videos",
    live.music && "music",
    live.voice && "voiceovers",
  ].filter((w): w is string => Boolean(w));
  // "Pictures, videos, music and voiceovers.", or as many of them as are set up.
  const mediaLine = media.length ? `${[media.slice(0, -1).join(", "), media.at(-1)].filter(Boolean).join(" and ")}.` : "";
  return {
    working: [
      "Your published apps and websites stay online for visitors, with their pages, forms, sign-ins and shop orders.",
      ...(images
        ? [`Free chats and pictures on free models, up to ${chats.toLocaleString("en-US")} chats and ${images.toLocaleString("en-US")} pictures a day.`]
        : chats
          ? [`Free chats on free models, up to ${chats.toLocaleString("en-US")} a day.`]
          : []),
    ],
    waiting: [
      ...(live.app ? ["New builds, and changes Flash makes to your apps."] : []),
      ...(live.text ? ["Chats on paid levels."] : []),
      ...(mediaLine ? [mediaLine[0].toUpperCase() + mediaLine.slice(1)] : []),
      ...(live.text ? ["The AI inside your apps answering visitors."] : []),
    ],
  };
}

const PARAGRAPH = "margin:0 0 12px;color:#52525b;line-height:1.5";
/** One line of a credit email, kept to one line of text: a name someone typed could hold anything. */
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();

/**
 * A credit email's body, in HTML and text alike: "Hi <name>," when Flash knows a name, the lines, and
 * each labelled list, so the text version says everything the HTML does.
 */
function creditBody(to: CreditEmailTo, lines: string[], lists: { label: string; items: string[] }[], intro?: string) {
  const name = oneLine(to.name ?? "", 60);
  const paragraphs = [...(name ? [`Hi ${name},`] : []), ...lines];
  const html = [
    ...paragraphs.map((p) => `<p style="${PARAGRAPH}">${escapeHtml(p)}</p>`),
    ...(intro ? [`<p style="margin:20px 0 0;color:#18181b;line-height:1.5;font-weight:600">${escapeHtml(intro)}</p>`] : []),
    ...lists.map(
      (list) =>
        `<p style="margin:16px 0 4px;color:#18181b;line-height:1.5;font-weight:600">${escapeHtml(list.label)}</p>\n<ul style="margin:0;padding-left:20px;color:#52525b;line-height:1.5">${list.items.map((item) => `<li style="margin:2px 0">${escapeHtml(item)}</li>`).join("")}</ul>`,
    ),
  ].join("\n");
  const text = [...paragraphs, ...(intro ? [intro] : []), ...lists.map((list) => `${list.label}\n${list.items.map((item) => `- ${item}`).join("\n")}`)].join("\n\n");
  return { html, text };
}

const creditLabels = (to: CreditEmailTo) => {
  const { working, waiting } = creditLists(to.free ?? null, to.live);
  return [
    { label: "Still working:", items: working },
    { label: "Waiting until you top up:", items: waiting },
  ].filter((list) => list.items.length);
};

/*
 * An automation's answer as its email shows it (plan §9.2): plain text. It was written by AI from what
 * it found, web pages among them, so nothing of it is a link or formatting that could pass for Flash's
 * own: a link is written out as its full address after its words, Markdown's marks come out (lists keep
 * their bullets and numbers, a table its rows, code its lines), and characters that turn text around
 * are dropped. A mail app may still underline an address it sees, but the words shown are the address.
 */
const URL_TEXT = String.raw`https?:\/\/(?:[^\s()<>\u0000]|\([^\s()<>\u0000]*\))+`;
// Its address in <> or not, and a title in "", '' or () after it.
const LINK = new RegExp(String.raw`(!?)\[([^\]\n]*)\]\(\s*<?(${URL_TEXT})>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)`, "gi");
// Any other link (javascript:, a page of the answer's own): its words only, but an email address's, or
// a web address in it, written out too.
const MAIL_LINK = /(!?)\[([^\]\n]*)\]\(mailto:([^\s()<>?]+)[^()\n]*\)/gi;
const OTHER_LINK = /(!?)\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;
const ANGLE_URL = new RegExp(String.raw`<(${URL_TEXT})>`, "gi");
const BARE_URL = new RegExp(URL_TEXT, "gi");
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// Controls but tabs and new lines, and the marks that override or embed a direction (an address could be shown backwards).
const UNSHOWN = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** A link's words and address as one: the address alone when its words are an address (that one, or another it would pass for). */
function writtenOut(words: string, url: string): string {
  const w = stripMarks(words).trim();
  return !w || w === url || /^(?:https?:\/\/|mailto:|[^\s@]+@)?(?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]+(?:[/?#:]\S*)?$/iu.test(w) ? url : `${w} (${url})`;
}

/** Bold and italic marks out of a line (the paired ones; an underscore only at a word's edges, as in Markdown). */
const stripMarks = (s: string) =>
  s
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)([^_\n]*?\S)__(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}*\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\p{L}\p{N}*])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_\\])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "$1");

/** One line's Markdown as plain text, its code and addresses as they are. */
function plainLine(line: string): string {
  const kept: string[] = [];
  const keep = (s: string) => `\u0000${kept.push(s) - 1}\u0000`;
  // What was kept inside a link's words (its code) back in place, before the words are kept themselves.
  const open = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
  const s = line
    .replace(/`([^`\n]+)`/g, (_, code: string) => keep(code))
    .replace(LINK, (_, image: string, words: string, url: string) => keep(writtenOut(open(words), url)))
    .replace(MAIL_LINK, (_, image: string, words: string, address: string) => keep(writtenOut(open(words), address)))
    .replace(OTHER_LINK, (_, image: string, words: string, to: string) => {
      const url = /https?:\/\/[^\s<>'"\u0000]+/i.exec(to)?.[0];
      return url ? keep(writtenOut(open(words), url)) : words;
    })
    .replace(ANGLE_URL, (_, url: string) => keep(url))
    // An address ends before the stop or comma after it.
    .replace(BARE_URL, (url: string) => {
      const end = /[.,;:!?'"]+$/.exec(url)?.[0] ?? "";
      return keep(url.slice(0, url.length - end.length)) + end;
    });
  return stripMarks(s)
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
}

/** An answer's Markdown as plain text (see above). */
export function answerText(markdown: string): string {
  const out: string[] = [];
  let fence = "";
  for (const raw of markdown.replace(/\r\n?/g, "\n").replace(UNSHOWN, "").split("\n")) {
    // At any indent: a list item's code is indented to its words.
    const mark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && !raw.trim().slice(mark.length).trim()) fence = "";
      else out.push(raw.trimEnd());
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push("");
    else if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(line)) continue;
    else if ((m = /^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/.exec(line))) out.push(plainLine(m[1]));
    else if ((m = /^(\s*)(?:>\s?)+(.*)$/.exec(line))) out.push(m[1] + plainLine(m[2]));
    else if ((m = /^(\s*)[-*+•]\s+(.*)$/.exec(line))) out.push(`${m[1]}• ${plainLine(m[2])}`);
    else if (TABLE_ROW.test(line))
      out.push(
        line
          .trim()
          .replace(/^\||\|$/g, "")
          .split(/(?<!\\)\|/)
          .map((cell) => plainLine(cell.trim()))
          .join(" | "),
      );
    else out.push(plainLine(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Plain text in an email's HTML: each paragraph its own direction, its lines and their spaces kept (a
 * line's indent also where a mail app ignores white-space, a tab as four spaces).
 */
function plainHtml(text: string, style = "margin:0 0 12px;color:#3f3f46;line-height:1.55"): string {
  return text
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map(
      (p) =>
        `<p dir="auto" style="${style};white-space:pre-wrap">${p
          .split("\n")
          .map((l) => escapeHtml(l.replace(/\t/g, "    ")).replace(/^ +/, (sp) => "&nbsp;".repeat(sp.length)))
          .join("<br>")}</p>`,
    )
    .join("\n");
}

/** An automation result email's words, already in its reader's language (see automation-alerts.ts). */
export type ResultWords = { subject: string; button: string; ai: string; more: string; sources: string; why: string; stop: string; paste: string; help: string };

export const EMAILS = {
  /*
   * An automation's result, to its owner's own confirmed address (see automation-alerts.ts). name is
   * the automation's (its owner typed it), intro the notice's line when it says more than that the
   * result is ready (its checks, or that it was cut short), result its answer as written (shown as
   * plain text, see answerText), cut whether the email has only its start, sources the pages it cites,
   * link where it opens in Flash (the email's only link but its stop link), stop the link that stops
   * these emails, and words the rest, in the owner's language.
   */
  automationResult: (r: {
    name: string;
    intro: string;
    result: string;
    cut?: boolean;
    sources?: { title: string; url: string }[];
    link: string;
    stop: string;
    words: ResultWords;
    lang: string;
    rtl: boolean;
  }) => {
    const name = oneLine(r.name, 80);
    const link = escapeHtml(r.link);
    const stop = escapeHtml(r.stop);
    const answer = answerText(r.result);
    const sources = r.sources ?? [];
    const sourceLines = sources.map((s) => (s.title ? `${s.title.replace(UNSHOWN, "")}\n${s.url}` : s.url));
    const small = "margin:0 0 8px;color:#52525b;font-size:13px;line-height:1.5";
    const blocks = [
      ...(r.intro ? [`<p dir="auto" style="margin:0 0 12px;color:#18181b;font-weight:600;line-height:1.5">${escapeHtml(r.intro)}</p>`] : []),
      plainHtml(answer),
      ...(r.cut ? [`<p style="margin:0 0 12px;color:#18181b;line-height:1.5">${escapeHtml(r.words.more)}</p>`] : []),
      ...(sources.length ? [`<p style="margin:16px 0 6px;color:#18181b;font-weight:600;line-height:1.4">${escapeHtml(r.words.sources)}</p>`, ...sourceLines.map((l) => plainHtml(l, small))] : []),
      `<p style="margin:16px 0 0;color:#71717a;font-size:13px;line-height:1.5">${escapeHtml(r.words.ai)}</p>`,
    ].join("\n");
    const footer = `${escapeHtml(r.words.why)}${afterSentence(r.words.why)}<a href="${stop}" style="color:#047857">${escapeHtml(r.words.stop)}</a>`;
    return {
      subject: oneLine(r.words.subject, 120),
      html: layout(escapeHtml(name), { blocks }, escapeHtml(r.words.button), link, footer, { lang: r.lang, rtl: r.rtl, paste: r.words.paste, help: r.words.help }),
      text: [
        ...(r.intro ? [r.intro] : []),
        answer,
        ...(r.cut ? [r.words.more] : []),
        ...(sources.length ? [`${r.words.sources}\n${sourceLines.map((l) => `- ${l.replace("\n", "\n  ")}`).join("\n")}`] : []),
        r.words.ai,
        `${r.words.button}: ${r.link}`,
        `${r.words.why}${afterSentence(r.words.why)}${r.words.stop}: ${r.stop}`,
      ].join("\n\n"),
    };
  },
  // A domain bought in Flash (see domain-checks.ts). domain is a registered name Flash checked, so plain.
  domainRenewal: (domain: string, expires: string, price: string, link: string) => {
    const heading = `${domain} ends on ${expires}`;
    const body = `Renew it in Flash for ${price} for one more year, so your site keeps its address. Flash only renews when you ask, and your card is charged only once the domain is renewed.`;
    return {
      subject: heading,
      html: layout(escapeHtml(heading), escapeHtml(body), "Renew in Flash", link, "You get this because you have this domain from Flash."),
      text: `${heading}\n\n${body}\n\nRenew in Flash: ${link}`,
    };
  },
  domainExpired: (domain: string, link: string) => {
    const heading = `${domain} has ended`;
    const body = "Your domain wasn't renewed, so it has stopped working. It may still be recovered for a few weeks: reply to this email and Flash will tell you the price.";
    return {
      subject: heading,
      html: layout(escapeHtml(heading), escapeHtml(body), "Open Flash", link, "You get this because you have this domain from Flash."),
      text: `${heading}\n\n${body}\n\n${link}`,
    };
  },
  domainVerify: (domain: string, email: string, link: string) => {
    const heading = `Confirm your details to keep ${domain}`;
    const body = `Name.com, the registrar of ${domain}, sent an email to ${email} to confirm your contact details. Please find it and click its link, or the domain will be paused. Can't find it? Press "Send it again" in Flash, under your site's Domain view.`;
    return {
      subject: heading,
      html: layout(escapeHtml(heading), escapeHtml(body), "Open Flash", link, "You get this because you have this domain from Flash."),
      text: `${heading}\n\n${body}\n\n${link}`,
    };
  },
  lowCredits: (credits: number, link: string, to: CreditEmailTo = {}) => {
    const left = `You have ${Math.max(0, credits).toLocaleString("en-US")} credits left.`;
    const heading = "Your Flash credits are running low";
    const body = creditBody(to, [LOW_CREDITS_LINE, left], creditLabels(to), "If they run out:");
    return {
      subject: heading,
      html: layout(heading, { blocks: body.html }, "Top up in Flash", link, ALERTS_OFF),
      text: `${heading}\n\n${body.text}\n\nTop up in Flash: ${link}\n\n${ALERTS_OFF}`,
    };
  },
  // Once the balance is at or below 0, when nothing paid can be held (see low-balance.ts).
  outOfCredits: (link: string, to: CreditEmailTo = {}) => {
    const body = creditBody(to, [OUT_OF_CREDITS_LINE], creditLabels(to));
    return {
      subject: OUT_OF_CREDITS_HEADING,
      html: layout(OUT_OF_CREDITS_HEADING, { blocks: body.html }, "Top up in Flash", link, ALERTS_OFF),
      text: `${OUT_OF_CREDITS_HEADING}\n\n${body.text}\n\nTop up in Flash: ${link}\n\n${ALERTS_OFF}`,
    };
  },
  // site is the app's title, which its owner typed: escaped, and kept to one line.
  appAiOutOfCredits: (site: string, link: string) => {
    const name = site.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "your app";
    const line = `Visitors are asking the AI in your app ${name}, but their questions aren't being answered because your Flash credits have run out. The rest of the app keeps working. Top up so it can answer them again.`;
    return {
      subject: `The AI in ${name.slice(0, 60)} is out of credits`,
      html: layout(
        `The AI in ${escapeHtml(name)} is out of credits`,
        escapeHtml(line),
        "Top up in Flash",
        link,
        ALERTS_OFF,
      ),
      text: `${line}\n\nTop up in Flash: ${link}\n\n${ALERTS_OFF}`,
    };
  },
  // The same when it stopped at the owner's auto top-up level (see site-ai.ts): their credits haven't run out.
  appAiAtLevel: (site: string, link: string) => {
    const name = site.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "your app";
    const line = `Visitors are asking the AI in your app ${name}, but their questions aren't being answered: with auto top-up on, it stops when your balance gets down to your top-up level, so your visitors never set off a top-up. The rest of the app keeps working. Top up so it can answer them again.`;
    return {
      subject: `The AI in ${name.slice(0, 60)} stopped at your auto top-up level`,
      html: layout(
        `The AI in ${escapeHtml(name)} stopped at your auto top-up level`,
        escapeHtml(line),
        "Top up in Flash",
        link,
        ALERTS_OFF,
      ),
      text: `${line}\n\nTop up in Flash: ${link}\n\n${ALERTS_OFF}`,
    };
  },
  teamInvite: (inviter: string, link: string) => ({
    subject: `${inviter.slice(0, 60)} invited you to their Flash ∞ AI team`,
    html: layout(
      "Join a team on Flash ∞ AI",
      `${escapeHtml(inviter.slice(0, 80))} invited you to their Business team. You'll share the team's monthly credits; your projects stay private. The link works for 14 days.`,
      "Join the team",
      link,
    ),
    text: `${inviter.slice(0, 80)} invited you to their Flash ∞ AI Business team (the link works for 14 days):\n${link}\n\nIf you don't know them, ignore this email.`,
  }),
  siteMessage: (site: string, preview: string, link: string) => ({
    subject: `New message from your site ${site.slice(0, 60)}`,
    html: layout(
      `New message on ${escapeHtml(site.slice(0, 80))}`,
      `Someone sent a form on your Flash site:<br><br><span style="color:#18181b;white-space:pre-wrap">${escapeHtml(preview)}</span>`,
      "Read it in Flash",
      link,
    ),
    text: `Someone sent a form on your Flash site ${site.slice(0, 80)}:\n\n${preview}\n\nRead your messages: ${link}`,
  }),
  siteOrder: (site: string, summary: string, link: string) => ({
    subject: `New order on your site ${site.slice(0, 60)}`,
    html: layout(
      `New order on ${escapeHtml(site.slice(0, 80))}`,
      `Someone paid on your Flash site:<br><br><span style="color:#18181b;white-space:pre-wrap">${escapeHtml(summary)}</span><br><br>The money is in your Stripe account.`,
      "See your orders",
      link,
    ),
    text: `Someone paid on your Flash site ${site.slice(0, 80)}:\n\n${summary}\n\nThe money is in your Stripe account. See your orders: ${link}`,
  }),
  // To Flash's admins. Everything but the links is what someone typed (the item's name, the
  // reporter's details), so it's escaped, and kept to one line where a line is expected.
  report: (r: { what: string; title: string; address: string; owner: string; reason: string; count: number; details: string; reporter: string; link: string }) => {
    const title = r.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "Untitled";
    const facts = [
      `${r.what}: ${title}`,
      `Address: ${r.address}`,
      `Owner: ${r.owner || "unknown"}`,
      `Reason: ${r.reason}`,
      `Reports about it: ${r.count}`,
      `Reporter's email: ${r.reporter.replace(/\s+/g, "") || "not given"}`,
    ].join("\n");
    return {
      subject: `New report: ${r.what.toLowerCase()} ${title.slice(0, 60)}`,
      html: layout(
        "New report on Flash ∞ AI",
        `<span style="color:#18181b;white-space:pre-wrap">${escapeHtml(facts)}${r.details ? `<br><br>${escapeHtml(r.details)}` : ""}</span>`,
        "Open Reports",
        r.link,
      ),
      text: `${facts}${r.details ? `\n\nDetails:\n${r.details}` : ""}\n\nReview it in the dashboard: ${r.link}`,
    };
  },
  verify: (link: string) => ({
    subject: "Confirm your email for Flash ∞ AI",
    html: layout("Confirm your email", "Confirm your email to get your free monthly credits.", "Confirm email", link),
    text: `Confirm your email to get your free monthly credits:\n${link}\n\nIf you didn't sign up for Flash ∞ AI, ignore this email.`,
  }),
  reset: (link: string) => ({
    subject: "Reset your Flash ∞ AI password",
    html: layout(
      "Reset your password",
      "Someone asked to reset the password for your Flash ∞ AI account. The link works for one hour.",
      "Choose a new password",
      link,
    ),
    text: `Reset your Flash ∞ AI password (the link works for one hour):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
  }),
  signin: (link: string) => ({
    subject: "Your Flash ∞ AI sign-in link",
    html: layout(
      "Sign in to Flash ∞ AI",
      "Use this button to sign in. It works once, for the next 15 minutes.",
      "Sign in",
      link,
    ),
    text: `Sign in to Flash ∞ AI (the link works once, for 15 minutes):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
  }),
  // A passkey added to or removed from the account (see passkeys.ts). name is the password manager's, or empty.
  passkeyChanged: (s: { change: "added" | "removed"; name: string; at: number; link: string }) => {
    const which = s.name ? `A passkey (${s.name})` : "A passkey";
    const line = `${which} was ${s.change === "added" ? "added to" : "removed from"} your Flash ∞ AI account on ${new Date(s.at).toUTCString()}.`;
    const heading = s.change === "added" ? "A passkey was added to your account" : "A passkey was removed from your account";
    return {
      subject: s.change === "added" ? "A passkey was added to your Flash ∞ AI account" : "A passkey was removed from your Flash ∞ AI account",
      html: layout(heading, escapeHtml(line), "Check your account", s.link, escapeHtml(PASSKEY_HELP)),
      text: `${line}\n\n${PASSKEY_HELP}\n\nOpen Flash: ${s.link}`,
    };
  },
  // A sign-in on a browser the account never used before (see new-device.ts). country is a two-letter code, or empty.
  newDevice: (s: { method: string; country: string; at: number; link: string }) => {
    const how = NEW_DEVICE_METHODS[s.method] ?? "your password";
    let where = "";
    try {
      where = s.country ? ` from ${new Intl.DisplayNames(["en"], { type: "region" }).of(s.country) ?? s.country}` : "";
    } catch {
      where = "";
    }
    const when = new Date(s.at).toUTCString();
    const line = `Your Flash ∞ AI account was just signed in to on a new device or browser, with ${how}${where}, on ${when}.`;
    const footer =
      "If this was you, there's nothing to do. If it wasn't, change your password now (Settings > Account, or \"Forgot password?\" on the sign-in page), then choose \"Log out of all devices\" there and turn on two-step sign-in.";
    return {
      subject: "New sign-in to your Flash ∞ AI account",
      html: layout("New sign-in to your account", escapeHtml(line), "Check your account", s.link, escapeHtml(footer)),
      text: `${line}\n\n${footer}\n\nOpen Flash: ${s.link}`,
    };
  },
};

const PASSKEY_HELP =
  "If this wasn't you, someone may be signed in to your account: choose \"Log out of all devices\" in Settings > Account (it removes every passkey too), then change your password and turn on two-step sign-in.";

const NEW_DEVICE_METHODS: Record<string, string> = {
  password: "your password",
  email_link: "an email sign-in link",
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  reset: "a password reset link",
  passkey: "a passkey",
};

/**
 * Sends one email, to one address or several, when today's budget allows its kind (see
 * EMAIL_BUDGET). Returns false when the budget held it back; account emails never are. With email
 * off, nothing is sent.
 */
export async function sendEmail(
  to: string | string[],
  message: { subject: string; html: string; text: string },
  kind: EmailKind,
  // headers: the email's own (List-Unsubscribe); once: a key the email provider sends one email for, however often it is asked (within a day).
  o: { headers?: Record<string, string>; once?: string } = {},
): Promise<boolean> {
  if (!emailEnabled()) return true;
  const recipients = Array.isArray(to) ? to : [to];
  const taken = await withinBudget(kind, recipients.length).catch((err) => {
    throw new EmailNotSent(`Email not sent: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  });
  if (!taken) return false;
  const res = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", ...(o.once && { "Idempotency-Key": o.once }) },
    // Replies reach support, except on an app's own emails to its owner (a form sent on their site), which aren't Flash's to answer.
    body: JSON.stringify({ from: FROM(), to: recipients, ...(typeof kind === "string" && { reply_to: SUPPORT }), ...message, ...(o.headers && { headers: o.headers }) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Refused, so it didn't go: what it took of today's emails goes back.
    const said = await res.text().catch(() => "");
    await Promise.all(taken.map((p) => giveBackSome(p.key, p.until, p.count))).catch(() => {});
    throw new EmailNotSent(`Email provider returned ${res.status}: ${said.slice(0, 200)}`, res.status);
  }
  return true;
}
