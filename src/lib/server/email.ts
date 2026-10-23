import { now } from "./db.ts";
import { countOf, giveBackOne, overLimit, takeOne, takeSome } from "./limits.ts";
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
 */
export type EmailKind = "account" | "new" | "other" | "report" | "alert" | "app-ai" | { owner: string };

/**
 * Whether today's budget lets an email of this kind go out, counting it when it does. Account
 * emails and the rest are counted apart, so sign-in emails never use up what orders and invites
 * get, and those never use up what sign-in emails keep. The day's totals count each recipient, so
 * an email to several never takes more than the provider allows.
 */
async function withinBudget(kind: EmailKind, recipients: number): Promise<boolean> {
  const day = new Date(now()).toISOString().slice(0, 10);
  const accounts = `email-day-acct:${day}`;
  const others = `email-day:${day}`;
  if (kind === "new" && (await overLimit(`email-new:${day}`, EMAIL_BUDGET.forNewAddresses, DAY))) {
    console.warn("[flash] today's sign-in emails to new addresses are used up");
    return false;
  }
  if (kind === "account" || kind === "new") {
    await overLimit(accounts, Infinity, DAY, recipients);
    return true;
  }
  // Checked first, so one person's busy apps (or a flood of reports) can't use up everyone else's share.
  if (typeof kind === "object" && (await overLimit(`email-owner:${kind.owner}`, EMAIL_BUDGET.perOwner, DAY))) return false;
  if (kind === "report" && (await overLimit(`email-report:${day}`, EMAIL_BUDGET.reports, DAY))) return false;
  // An alert's own share, then the day's shared emails, each taken in one statement, so emails at the
  // same moment get every place there is (and no more), and one refused takes nothing: an alert's
  // place is handed back when the shared emails then refuse it.
  const share =
    kind === "alert"
      ? { key: `email-alert:${day}`, max: EMAIL_BUDGET.alerts }
      : kind === "app-ai"
        ? { key: `email-app-ai:${day}`, max: EMAIL_BUDGET.appAiAlerts }
        : null;
  const shareUntil = share ? await takeOne(share.key, share.max, DAY) : null;
  if (share && shareUntil === null) return false;
  const full = (await countOf(accounts)) + (await countOf(others)) + recipients > EMAIL_BUDGET.perDay;
  if (full || (await takeSome(others, EMAIL_BUDGET.perDay - EMAIL_BUDGET.keptForAccounts, DAY, recipients)) === null) {
    if (share && shareUntil !== null) await giveBackOne([[share.key, shareUntil]]);
    console.warn("[flash] today's emails for apps and invites are used up; raise EMAIL_BUDGET in email.ts on a bigger email plan");
    return false;
  }
  return true;
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

/** An email's page: body is one paragraph's HTML, or (blocks) paragraphs and lists already made with block(). */
function layout(heading: string, body: string | { blocks: string }, button: string, link: string, footer = IGNORE): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
<div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;padding:32px">
<div style="font-size:20px;font-weight:700;color:#047857">Flash ∞ AI</div>
<h1 style="font-size:20px;margin:24px 0 8px">${heading}</h1>
${typeof body === "string" ? `<p style="color:#52525b;line-height:1.5">${body}</p>` : body.blocks}
<p style="margin:24px 0"><a href="${link}" style="background:#047857;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${button}</a></p>
<p style="color:#a1a1aa;font-size:12px;line-height:1.5">Or paste this link into your browser:<br>${link}</p>
<p style="color:#a1a1aa;font-size:12px">${footer}</p>
<p style="color:#a1a1aa;font-size:12px">Need help with Flash? Write to <a href="mailto:${SUPPORT}" style="color:#047857">${SUPPORT}</a>.</p>
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

export const EMAILS = {
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
export async function sendEmail(to: string | string[], message: { subject: string; html: string; text: string }, kind: EmailKind): Promise<boolean> {
  if (!emailEnabled()) return true;
  const recipients = Array.isArray(to) ? to : [to];
  if (!(await withinBudget(kind, recipients.length))) return false;
  const res = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    // Replies reach support, except on an app's own emails to its owner (a form sent on their site), which aren't Flash's to answer.
    body: JSON.stringify({ from: FROM(), to: recipients, ...(typeof kind === "string" && { reply_to: SUPPORT }), ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
