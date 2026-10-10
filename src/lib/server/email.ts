import { now } from "./db.ts";
import { overLimit } from "./limits.ts";

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
};

const DAY = 86_400_000;

/**
 * What an email is, which decides whether today's budget lets it go out:
 * - "account": sign-in links, email confirmations and password resets. Always sent.
 * - "other": team invitations and shop orders, sent while the day's budget lasts. Each needs a
 *   paid plan or a real payment, so nobody can send many for free.
 * - { owner }: a published app's form message to the user who owns the app. Anyone can send
 *   forms, so these also stop at the owner's own daily cap.
 */
export type EmailKind = "account" | "other" | { owner: string };

/** Whether today's budget lets an email of this kind go out, counting it when it does. */
async function withinBudget(kind: EmailKind): Promise<boolean> {
  const today = `email-day:${new Date(now()).toISOString().slice(0, 10)}`;
  if (kind === "account") {
    // Never held back, so nobody is locked out, but counted so other emails leave room for these.
    await overLimit(today, Infinity, DAY);
    return true;
  }
  // Checked first, so one person's busy apps can't use up everyone else's share.
  if (typeof kind === "object" && (await overLimit(`email-owner:${kind.owner}`, EMAIL_BUDGET.perOwner, DAY))) return false;
  if (await overLimit(today, EMAIL_BUDGET.perDay - EMAIL_BUDGET.keptForAccounts, DAY)) {
    console.warn("[flash] today's emails for apps and invites are used up; raise EMAIL_BUDGET in email.ts on a bigger email plan");
    return false;
  }
  return true;
}

export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY);
export const demoEmails = () => !emailEnabled() && process.env.FLASH_DEMO_EMAILS === "true";
/** Whether new accounts must confirm their email before getting free credits. */
export const verificationRequired = () => emailEnabled() || demoEmails();

const FROM = () => process.env.FLASH_EMAIL_FROM || "Flash AI <hello@flash-app.dev>";

function layout(heading: string, body: string, button: string, link: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
<div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;padding:32px">
<div style="font-size:20px;font-weight:700;color:#047857">Flash AI</div>
<h1 style="font-size:20px;margin:24px 0 8px">${heading}</h1>
<p style="color:#52525b;line-height:1.5">${body}</p>
<p style="margin:24px 0"><a href="${link}" style="background:#047857;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${button}</a></p>
<p style="color:#a1a1aa;font-size:12px;line-height:1.5">Or paste this link into your browser:<br>${link}</p>
<p style="color:#a1a1aa;font-size:12px">If you didn't ask for this, you can ignore this email.</p>
</div></body></html>`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const EMAILS = {
  teamInvite: (inviter: string, link: string) => ({
    subject: `${inviter.slice(0, 60)} invited you to their Flash AI team`,
    html: layout(
      "Join a team on Flash AI",
      `${escapeHtml(inviter.slice(0, 80))} invited you to their Business team. You'll share the team's monthly credits; your projects stay private. The link works for 14 days.`,
      "Join the team",
      link,
    ),
    text: `${inviter.slice(0, 80)} invited you to their Flash AI Business team (the link works for 14 days):\n${link}\n\nIf you don't know them, ignore this email.`,
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
  verify: (link: string) => ({
    subject: "Confirm your email for Flash AI",
    html: layout("Confirm your email", "Confirm your email to get your free monthly credits.", "Confirm email", link),
    text: `Confirm your email to get your free monthly credits:\n${link}\n\nIf you didn't sign up for Flash AI, ignore this email.`,
  }),
  reset: (link: string) => ({
    subject: "Reset your Flash AI password",
    html: layout(
      "Reset your password",
      "Someone asked to reset the password for your Flash AI account. The link works for one hour.",
      "Choose a new password",
      link,
    ),
    text: `Reset your Flash AI password (the link works for one hour):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
  }),
  signin: (link: string) => ({
    subject: "Your Flash AI sign-in link",
    html: layout(
      "Sign in to Flash AI",
      "Use this button to sign in. It works once, for the next 15 minutes.",
      "Sign in",
      link,
    ),
    text: `Sign in to Flash AI (the link works once, for 15 minutes):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
  }),
};

/**
 * Sends one email, when today's budget allows its kind (see EMAIL_BUDGET). Returns false when the
 * budget held it back; account emails never are. With email off, nothing is sent.
 */
export async function sendEmail(to: string, message: { subject: string; html: string; text: string }, kind: EmailKind): Promise<boolean> {
  if (!emailEnabled()) return true;
  if (!(await withinBudget(kind))) return false;
  const res = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
