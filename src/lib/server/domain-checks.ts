import { all, one, run, now } from "./db.ts";
import { EMAILS, sendEmail } from "./email.ts";
import { getDomain, resendVerification, type NamecomMode } from "./namecom.ts";
import { domainPriceCents, usd } from "../domain-price.ts";

/*
 * Keeping the domains customers bought in Flash healthy (see domain-orders.ts), once a day
 * (/api/cron/domains): their end date and their registrant's confirmation from Name.com, domains
 * moved to another registrar, and the emails that go with them:
 *
 *   - "confirm your details" 2 and 10 days after the purchase while Name.com's email isn't clicked
 *     (an unconfirmed registrant gets the domain paused);
 *   - "renew it" 60, 30, 14 and 7 days before the end, and once when it has ended.
 *
 * Renewing is the customer's choice (Renew now), never automatic: Flash charges nothing it wasn't asked to.
 */

const DAY = 24 * 60 * 60_000;
const NOTICE_DAYS = [60, 30, 14, 7];
const VERIFY_AFTER_DAYS = [2, 10];

export type OwnedDomain = {
  domain: string;
  user_id: string;
  for_site: string | null;
  mode: NamecomMode;
  status: "active" | "expired" | "moved";
  renew: string;
  registered_at: number;
  expires_at: number;
  renewal_cost_cents: number;
  registrant_email: string;
  verified_at: number;
  verification_id: number;
  last_notice: number;
  verify_notices: number;
};

const appLink = () => `${(process.env.FLASH_APP_URL?.trim() || "https://www.flash-app.dev").replace(/\/+$/, "")}/?apps=1`;
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** The renewal reminder due now for a domain ending at expires: days before (60, 30, 14, 7), -1 once ended, or 0 for none. */
export function noticeDue(expires: number, lastNotice: number, at = now()): number {
  const left = (expires - at) / DAY;
  if (left <= 0) return lastNotice === -1 ? 0 : -1;
  const due = NOTICE_DAYS.filter((d) => left <= d).at(-1) ?? 0;
  // Each one goes once; a later (smaller) one replaces an earlier.
  return due && (lastNotice === 0 || due < lastNotice) && lastNotice !== -1 ? due : 0;
}

/** Brings one domain up to date with Name.com, then sends what is due. */
async function checkOne(d: OwnedDomain): Promise<void> {
  const at = now();
  let info;
  try {
    info = await getDomain(d.mode, d.domain);
  } catch {
    return;
  }
  if (!info) {
    // Gone from Flash's Name.com account: moved to another registrar (or, in the sandbox, reset).
    await run("UPDATE owned_domains SET status = 'moved', updated_at = ? WHERE domain = ?", [at, d.domain]);
    return;
  }
  const expires = Date.parse(info.expireDate);
  const registrant = info.contacts?.registrant;
  const verified = registrant?.isVerified ? d.verified_at || at : 0;
  const next = {
    expires: Number.isFinite(expires) ? expires : d.expires_at,
    renewal: info.renewalPrice ? Math.round(info.renewalPrice * 100) : d.renewal_cost_cents,
    verificationId: registrant?.verificationId ?? d.verification_id,
  };
  const status = next.expires <= at ? "expired" : "active";
  await run(
    `UPDATE owned_domains SET expires_at = ?, renewal_cost_cents = ?, verified_at = ?, verification_id = ?, status = ?,
       last_notice = CASE WHEN ? > expires_at + 180 * 86400000 THEN 0 ELSE last_notice END, updated_at = ? WHERE domain = ?`,
    [next.expires, next.renewal, verified, next.verificationId ?? 0, status, next.expires, at, d.domain],
  );
  const lastNotice = next.expires > d.expires_at + 180 * DAY ? 0 : d.last_notice;
  const to = d.registrant_email || (await one<{ email: string }>("SELECT email FROM users WHERE id = ?", [d.user_id]))?.email;
  if (!to || d.mode === "sandbox") return;

  const due = noticeDue(next.expires, lastNotice, at);
  if (due && d.renew !== "off") {
    const message =
      due === -1
        ? EMAILS.domainExpired(d.domain, appLink())
        : EMAILS.domainRenewal(d.domain, dateOf(next.expires), usd(domainPriceCents(next.renewal)), appLink());
    // Claimed first, so two runs never send the same one.
    const claimed = await run("UPDATE owned_domains SET last_notice = ? WHERE domain = ? AND last_notice = ?", [due, d.domain, lastNotice]);
    if (claimed.rowsAffected === 1) await sendEmail(to, message, "account").catch((err) => console.error("[flash] domain notice failed", d.domain, err));
  }

  const age = (at - d.registered_at) / DAY;
  const verifyDue = VERIFY_AFTER_DAYS.filter((days) => age >= days).length;
  if (!verified && d.verify_notices < verifyDue) {
    const claimed = await run("UPDATE owned_domains SET verify_notices = ? WHERE domain = ? AND verify_notices = ?", [verifyDue, d.domain, d.verify_notices]);
    if (claimed.rowsAffected === 1) {
      await sendEmail(to, EMAILS.domainVerify(d.domain, to, appLink()), "account").catch((err) => console.error("[flash] domain verify email failed", d.domain, err));
    }
  }
}

/** The daily check: the domains looked at longest ago first, a batch at a time so it stays well within the time limit. */
export async function checkDomains(limit = 60): Promise<number> {
  const due = await all<OwnedDomain>(
    "SELECT * FROM owned_domains WHERE status IN ('active', 'expired') AND updated_at < ? ORDER BY updated_at LIMIT ?",
    [now() - 20 * 60 * 60_000, limit],
  );
  for (const d of due) await checkOne(d).catch((err) => console.error("[flash] domain check", d.domain, err));
  return due.length;
}

export type OwnedView = {
  domain: string;
  expiresAt: number;
  verified: boolean;
  renewPriceCents: number;
  status: OwnedDomain["status"];
  sandbox: boolean;
  canRenew: boolean;
};

/** The domains a user has from Flash for one of their sites. */
export async function ownedForSite(userId: string, slug: string): Promise<OwnedView[]> {
  const rows = await all<OwnedDomain>("SELECT * FROM owned_domains WHERE user_id = ? AND for_site = ? AND status != 'moved' ORDER BY created_at", [userId, slug]);
  return rows.map((d) => ({
    domain: d.domain,
    expiresAt: d.expires_at,
    verified: d.verified_at > 0 || d.mode === "sandbox",
    renewPriceCents: domainPriceCents(d.renewal_cost_cents),
    status: d.status,
    sandbox: d.mode === "sandbox",
    canRenew: d.renew !== "off",
  }));
}

/**
 * Asks Name.com to send the registrant its confirmation email again. "wait" when Name.com allows it
 * only later; "done" when it's already confirmed.
 */
export async function resendDomainEmail(userId: string, domain: string): Promise<"sent" | "done" | "wait" | "missing" | "failed"> {
  const d = await one<OwnedDomain>("SELECT * FROM owned_domains WHERE domain = ? AND user_id = ?", [domain, userId]);
  if (!d || d.status === "moved") return "missing";
  if (d.verified_at) return "done";
  let id = d.verification_id;
  if (!id) {
    const info = await getDomain(d.mode, domain).catch(() => null);
    if (info?.contacts?.registrant?.isVerified) {
      await run("UPDATE owned_domains SET verified_at = ? WHERE domain = ?", [now(), domain]);
      return "done";
    }
    id = info?.contacts?.registrant?.verificationId ?? 0;
    if (id) await run("UPDATE owned_domains SET verification_id = ? WHERE domain = ?", [id, domain]);
  }
  if (!id) return "failed";
  const status = await resendVerification(d.mode, id);
  return status === 200 || status === 204 ? "sent" : status === 429 ? "wait" : "failed";
}
