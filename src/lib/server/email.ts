import { now } from "./db.ts";
import { countOf, giveBackOne, overLimit, takeOne, takeSome } from "./limits.ts";
import { BRAND_NAME } from "../product.ts";

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
  // Low-credit emails, a day (see low-balance.ts): someone's credits falling below the level they
  // picked. They come out of what app emails and invites share, never what sign-in emails keep, and
  // stop at this many: one that can't go out waits for a later day, and Flash still shows it in the app.
  alerts: 10,
  // "Your app's AI is out of credits" emails to app owners, a day (see low-balance.ts), the same way.
  // Visitors set these off, so they have a share of their own and never use up the low-credit emails'.
  appAiAlerts: 5,
  // Of those, what one owner may get in a day, whichever of their apps' visitors set it off, so one
  // busy app never takes more than its owner's own place in the share above.
  appAiPerOwner: 1,
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
 * - { appAi }: an "app's AI is out of credits" email (low-balance.ts) to that owner. These also stop
 *   at EMAIL_BUDGET.appAiPerOwner a day for the owner, and EMAIL_BUDGET.appAiAlerts a day for all.
 */
export type EmailKind = "account" | "new" | "other" | "report" | "alert" | { appAi: string } | { owner: string };

/**
 * Whether today's budget lets an email of this kind go out, counting it when it does. Account
 * emails and the rest are counted apart, so sign-in emails never use up what orders and invites
 * get, and those never use up what sign-in emails keep. The day's totals count each recipient, so
 * an email to several never takes more than the provider allows.
 */
async function withinBudget(kind: EmailKind, recipients: number): Promise<boolean> {
  const t = now();
  const day = new Date(t).toISOString().slice(0, 10);
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
  if (typeof kind === "object" && "owner" in kind && (await overLimit(`email-owner:${kind.owner}`, EMAIL_BUDGET.perOwner, DAY))) return false;
  if (kind === "report" && (await overLimit(`email-report:${day}`, EMAIL_BUDGET.reports, DAY))) return false;
  // An alert's own share (for an app-AI email, its owner's own place first, so one busy app never
  // takes another owner's), then the day's shared emails, each taken in one statement, so emails at
  // the same moment get every place there is (and no more), and one refused takes nothing: the places
  // it took are handed back when a later one refuses it. The owner's place lasts until the day's end
  // (UTC), as the day's shares do, on one row per owner.
  const restOfDay = (Math.floor(t / DAY) + 1) * DAY - 1 - t;
  const shares =
    kind === "alert"
      ? [{ key: `email-alert:${day}`, max: EMAIL_BUDGET.alerts, window: DAY }]
      : typeof kind === "object" && "appAi" in kind
        ? [
            { key: `email-app-ai-owner:${kind.appAi}`, max: EMAIL_BUDGET.appAiPerOwner, window: restOfDay },
            { key: `email-app-ai:${day}`, max: EMAIL_BUDGET.appAiAlerts, window: DAY },
          ]
        : [];
  const taken: [string, number][] = [];
  for (const share of shares) {
    const until = await takeOne(share.key, share.max, share.window);
    if (until === null) {
      await giveBackOne(taken);
      return false;
    }
    taken.push([share.key, until]);
  }
  const full = (await countOf(accounts)) + (await countOf(others)) + recipients > EMAIL_BUDGET.perDay;
  if (full || (await takeSome(others, EMAIL_BUDGET.perDay - EMAIL_BUDGET.keptForAccounts, DAY, recipients)) === null) {
    await giveBackOne(taken);
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

const IGNORE = "If you didn't ask for this, you can ignore this email.";

function layout(heading: string, body: string, button: string, link: string, footer = IGNORE): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
<div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;padding:32px">
<div style="font-size:20px;font-weight:700;color:#047857">Flash ∞ AI</div>
<h1 style="font-size:20px;margin:24px 0 8px">${heading}</h1>
<p style="color:#52525b;line-height:1.5">${body}</p>
<p style="margin:24px 0"><a href="${link}" style="background:#047857;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${button}</a></p>
<p style="color:#a1a1aa;font-size:12px;line-height:1.5">Or paste this link into your browser:<br>${link}</p>
<p style="color:#a1a1aa;font-size:12px">${footer}</p>
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

export const EMAILS = {
  lowCredits: (credits: number, link: string) => {
    const left = `You have ${Math.max(0, credits).toLocaleString("en-US")} credits left.`;
    return {
      subject: "Your Flash credits are running low",
      html: layout(
        "Your Flash credits are running low",
        `${LOW_CREDITS_LINE}<br><br><span style="color:#18181b">${left}</span>`,
        "Top up in Flash",
        link,
        ALERTS_OFF,
      ),
      text: `${LOW_CREDITS_LINE}\n\n${left}\n\nTop up in Flash: ${link}\n\n${ALERTS_OFF}`,
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
    body: JSON.stringify({ from: FROM(), to: recipients, ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
