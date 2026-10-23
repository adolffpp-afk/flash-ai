/*
 * Teams in published apps: who may sign in, and what each person may do. An app is open to anyone
 * who signs up, or only to the people its owner invited by email. Each invited person is a member
 * or a manager: managers may change any of the team's records, and see everyone's in a "personal"
 * collection (see data-rules.ts). Everything here is checked on the server for every request; what
 * the app's own code shows or hides is only for looks.
 *
 * Unless the owner chose, an app whose rules keep data for a team ("team" or "personal") is open
 * only to invited people, so nobody can sign themselves up to a CRM and read its customers.
 */
import { all, one, run, now } from "./db.ts";
import { parseComputed, teamRules } from "../data-rules.ts";
import { cleanEmail } from "../contacts.ts";
import type { SiteVisitor } from "./site-auth.ts";

export type TeamRole = "manager" | "member";
export type AppAccess = "anyone" | "invited";
export const TEAM_ROLES: readonly TeamRole[] = ["member", "manager"];
export const isTeamRole = (v: unknown): v is TeamRole => v === "member" || v === "manager";
export const MAX_INVITES = 2000;

/** Who may sign in to an app: what its owner chose ("" when they didn't) and what holds. Null when there's no such app. */
export async function appAccess(slug: string): Promise<{ chosen: AppAccess | ""; access: AppAccess } | null> {
  // The owner's own rules count too: choosing "team" for a collection in Flash closes the app as well.
  const site = await one<{ access: string; data_rules: string; owner_team: number }>(
    `SELECT access, data_rules, EXISTS (SELECT 1 FROM site_collection_rules r WHERE r.site_slug = s.slug AND r.rule IN ('team', 'personal')) AS owner_team
     FROM sites s WHERE slug = ?`,
    [slug],
  );
  if (!site) return null;
  const chosen = site.access === "anyone" || site.access === "invited" ? site.access : "";
  return { chosen, access: chosen || (site.owner_team || teamRules(parseComputed(site.data_rules)) ? "invited" : "anyone") };
}

export const invitedOnly = async (slug: string) => (await appAccess(slug))?.access === "invited";

/** The owner chooses who may sign in, or leaves it to Flash with "". */
export async function chooseAccess(slug: string, access: AppAccess | ""): Promise<void> {
  await run("UPDATE sites SET access = ? WHERE slug = ?", [access, slug]);
}

/** The role the owner gave this address, or null when they didn't invite it. */
export async function invitedRole(slug: string, email: string): Promise<TeamRole | null> {
  const row = await one<{ role: string }>("SELECT role FROM site_invites WHERE site_slug = ? AND email = ?", [slug, email.trim().toLowerCase()]);
  return row ? (row.role === "manager" ? "manager" : "member") : null;
}

export async function listInvites(slug: string): Promise<{ email: string; role: TeamRole; createdAt: number; joined: boolean }[]> {
  const rows = await all<{ email: string; role: string; created_at: number; joined: number }>(
    `SELECT i.email, i.role, i.created_at, EXISTS (SELECT 1 FROM site_users u WHERE u.site_slug = i.site_slug AND u.email = i.email) AS joined
     FROM site_invites i WHERE i.site_slug = ? ORDER BY i.created_at DESC LIMIT ?`,
    [slug, MAX_INVITES],
  );
  return rows.map((r) => ({ email: r.email, role: r.role === "manager" ? "manager" : "member", createdAt: Number(r.created_at), joined: Boolean(r.joined) }));
}

/**
 * The owner invites addresses (or changes their role). Returns how many were saved, or why none were:
 * "bad-email" when one isn't an address, "full" past MAX_INVITES.
 */
export async function invite(slug: string, emails: string[], role: TeamRole): Promise<{ saved: number } | { error: "bad-email" | "full" }> {
  const clean = [...new Set(emails.map((e) => cleanEmail(e).toLowerCase()))];
  if (!clean.length || clean.some((e) => !e)) return { error: "bad-email" };
  const count = Number((await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_invites WHERE site_slug = ?", [slug]))?.n ?? 0);
  if (count + clean.length > MAX_INVITES) return { error: "full" };
  for (const email of clean) {
    await run(
      `INSERT INTO site_invites (site_slug, email, role, created_at) SELECT slug, ?, ?, ? FROM sites WHERE slug = ?
       ON CONFLICT (site_slug, email) DO UPDATE SET role = excluded.role`,
      [email, role, now(), slug],
    );
  }
  return { saved: clean.length };
}

/** The owner takes an invitation back. In an app open only to invited people, that person's sign-ins end too. */
export async function uninvite(slug: string, email: string): Promise<boolean> {
  const r = await run("DELETE FROM site_invites WHERE site_slug = ? AND email = ?", [slug, email.trim().toLowerCase()]);
  if (await invitedOnly(slug)) await endSignIns(slug, email);
  return r.rowsAffected > 0;
}

/** Ends every sign-in of the person with this address in the app. */
async function endSignIns(slug: string, email: string): Promise<void> {
  const user = await one<{ id: string }>("SELECT id FROM site_users WHERE site_slug = ? AND email = ?", [slug, email.trim().toLowerCase()]);
  if (!user) return;
  await run("DELETE FROM site_sessions WHERE site_slug = ? AND site_user_id = ?", [slug, user.id]);
  await run("DELETE FROM site_page_tokens WHERE site_slug = ? AND site_user_id = ?", [slug, user.id]);
}

export type TeamVisitor = SiteVisitor & { role: TeamRole };

/**
 * Someone signed in to the app, with their role, or null when they may not use it any more: in an
 * app open only to invited people, someone whose invitation was taken back.
 */
export async function asMember(slug: string, who: SiteVisitor | null): Promise<TeamVisitor | null> {
  if (!who) return null;
  const role = await invitedRole(slug, who.email);
  if (!role && (await invitedOnly(slug))) return null;
  return { ...who, role: role ?? "member" };
}

