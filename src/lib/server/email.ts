/*
 * Sends account emails (verification, password reset and sign-in links) through Resend when RESEND_API_KEY is
 * set. Without it, email verification is off and password reset is unavailable, unless
 * FLASH_DEMO_EMAILS=true, which shows the link on screen for testing (never in production).
 */
const RESEND_API = process.env.RESEND_BASE_URL || "https://api.resend.com";

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

/** Sends one email. Returns the link instead when demo emails are on. */
export async function sendEmail(to: string, message: { subject: string; html: string; text: string }): Promise<void> {
  if (!emailEnabled()) return;
  const res = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Email provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
