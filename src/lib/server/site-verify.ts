/*
 * Proving that someone using an app owns their email address, with a one-time link. An invitation
 * is to an address, so in an app open only to invited people an account counts only once its
 * address is proved: otherwise anyone who knew an invited address could sign up with it first and
 * take that person's place, a manager's included (see site-team.ts).
 *
 * Each link carries the password chosen when it was asked for, and using it sets that password. So
 * until the address is proved, signing up again (the real owner of the address, after someone else
 * tried it) simply asks for a new link with the new password: the account is nobody's yet.
 */
import { SITE_URL } from "../../app/site.ts";
import { one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { overLimit } from "./limits.ts";
import { sendEmail } from "./email.ts";

const LINK_HOURS = 24;
const HOUR = 3_600_000;

export async function isVerified(userId: string): Promise<boolean> {
  return Number((await one<{ at: number }>("SELECT email_verified_at AS at FROM site_users WHERE id = ?", [userId]))?.at ?? 0) > 0;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Emails a link that proves the address, a few times an hour at most per address and per app, so
 * nobody can use an app to flood an inbox. The link works once, for a day.
 */
export async function sendVerifyLink(slug: string, user: { id: string; email: string }, passwordHash: string): Promise<void> {
  if (await overLimit(`site-verify:${slug}:${user.email}`, 3, HOUR)) return;
  if (await overLimit(`site-verify:${slug}`, 200, HOUR)) return;
  const token = randomId(32);
  await run("DELETE FROM site_email_tokens WHERE expires_at < ?", [now()]);
  await run("INSERT INTO site_email_tokens (token_hash, site_user_id, site_slug, expires_at, password_hash) VALUES (?, ?, ?, ?, ?)", [
    sha256(token),
    user.id,
    slug,
    now() + LINK_HOURS * HOUR,
    passwordHash,
  ]);
  const site = await one<{ title: string }>("SELECT title FROM sites WHERE slug = ?", [slug]);
  const app = (site?.title || "this app").slice(0, 80);
  const link = `${(process.env.FLASH_APP_URL || SITE_URL).replace(/\/+$/, "")}/api/sites/${slug}/auth/verify?t=${token}`;
  await sendEmail(
    user.email,
    {
      subject: `Confirm your email for ${app}`,
      text: `Someone just signed up to ${app} with this email address. If it was you, open this link to confirm it, then sign in with the password you chose:\n\n${link}\n\nThe link works once, for ${LINK_HOURS} hours. If it wasn't you, don't open the link: ignore this email and nothing happens.`,
      html: `<p>Someone just signed up to <strong>${escape(app)}</strong> with this email address. If it was you, confirm it, then sign in with the password you chose.</p><p><a href="${link}">Yes, it was me: confirm my email</a></p><p style="color:#71717a;font-size:13px">The link works once, for ${LINK_HOURS} hours. If it wasn't you, don't open the link: ignore this email and nothing happens.</p>`,
    },
    "account",
  ).catch((err) => console.error("[flash] app verify email not sent", err));
}

/** Uses a link: the address it was sent to is proved. False when it was used already, is too old, or isn't this app's. */
export async function confirmVerifyLink(slug: string, token: string): Promise<boolean> {
  if (!/^[\w-]{16,80}$/.test(token)) return false;
  const row = await one<{ site_user_id: string; password_hash: string }>(
    "DELETE FROM site_email_tokens WHERE token_hash = ? AND site_slug = ? AND expires_at > ? RETURNING site_user_id, password_hash",
    [sha256(token), slug, now()],
  );
  if (!row?.password_hash) return false;
  // Only an account not proved yet: a proved one's password is changed only by its owner.
  const done = await run("UPDATE site_users SET email_verified_at = ?, password_hash = ? WHERE id = ? AND site_slug = ? AND email_verified_at = 0", [
    now(),
    row.password_hash,
    row.site_user_id,
    slug,
  ]);
  // The other links for it are spent: they carry passwords that weren't chosen.
  if (done.rowsAffected) await run("DELETE FROM site_email_tokens WHERE site_user_id = ?", [row.site_user_id]);
  return done.rowsAffected > 0;
}
