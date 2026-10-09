import { all, one, run, now } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { emailKey, isVerified } from "./account.ts";
import { EMAILS, demoEmails, sendEmail } from "./email.ts";
import { activeSubscription, planById, type Subscription } from "./subscriptions.ts";
import { fullName } from "../names.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * Business plan teams. The owner pays, and the owner's credit balance is the team's shared pool:
 * the plan's monthly credits land there, and members spend from it (see charge() in credits.ts)
 * while the owner's team plan is paid up. Members keep their own account, projects and credits.
 */

const INVITE_DAYS = 14;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class TeamError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The user's own paid-up team plan, if they have one. */
export async function ownTeamPlan(userId: string): Promise<Subscription | null> {
  const sub = await activeSubscription(userId);
  return sub && planById(sub.plan)?.seats ? sub : null;
}

/**
 * The team plan whose pool a member spends: the owner's paid-up team subscription (its user_id is
 * the owner). Null for owners (their own balance is the pool) and for users outside a team.
 */
export async function teamPool(userId: string): Promise<Subscription | null> {
  const row = await one<{ owner_id: string }>(
    "SELECT t.owner_id FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?",
    [userId],
  );
  if (!row || row.owner_id === userId) return null;
  if (await ownTeamPlan(userId)) return null;
  return ownTeamPlan(row.owner_id);
}

async function teamOf(ownerId: string): Promise<{ id: string } | null> {
  return one<{ id: string }>("SELECT id FROM teams WHERE owner_id = ?", [ownerId]);
}

async function seatsUsed(teamId: string): Promise<number> {
  const row = await one<{ members: number; invites: number }>(
    `SELECT (SELECT COUNT(*) FROM team_members WHERE team_id = ?) AS members,
            (SELECT COUNT(*) FROM team_invites WHERE team_id = ? AND expires_at > ?) AS invites`,
    [teamId, teamId, now()],
  );
  // The owner takes one seat.
  return 1 + Number(row?.members ?? 0) + Number(row?.invites ?? 0);
}

/** Emails an invitation to join the owner's team. In demo mode the link is returned. `t` words the reasons it can't. */
export async function inviteMember(
  owner: { id: string; email: string; name: string },
  email: string,
  origin: string,
  t: Translate = english,
): Promise<string | undefined> {
  const sub = await ownTeamPlan(owner.id);
  const plan = sub && planById(sub.plan);
  if (!plan?.seats) throw new TeamError(t("Inviting people needs an active Business plan."), 403);
  email = email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new TeamError(t("Enter a valid email address."));
  const key = emailKey(email);
  if (key === emailKey(owner.email)) throw new TeamError(t("You're already on your team."));

  await run("INSERT OR IGNORE INTO teams (id, owner_id, created_at) VALUES (?, ?, ?)", [randomId(), owner.id, now()]);
  const team = (await teamOf(owner.id))!;
  const member = await one(
    "SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.email_key = ?",
    [team.id, key],
  );
  if (member) throw new TeamError(t("That person is already on your team."), 409);
  // A new invite to the same address replaces the old one.
  await run("DELETE FROM team_invites WHERE team_id = ? AND email_key = ?", [team.id, key]);
  if ((await seatsUsed(team.id)) >= plan.seats) {
    throw new TeamError(t("Your plan has {seats} seats, the owner included. Remove someone first.", { seats: plan.seats }), 409);
  }
  const token = randomId(32);
  await run(
    "INSERT INTO team_invites (id, token_hash, team_id, email, email_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [randomId(), sha256(token), team.id, email, key, now() + INVITE_DAYS * 24 * 3600_000, now()],
  );
  const link = `${origin}/?invite=${token}`;
  await sendEmail(email, EMAILS.teamInvite(fullName(owner).replace(/\s+/g, " "), link));
  return demoEmails() ? link : undefined;
}

/** Joins the team an invitation is for. The invite only works for the address it was sent to. `t` words the reasons it can't. */
export async function acceptInvite(
  user: { id: string; email: string; verified_at?: number | null },
  token: string,
  t: Translate = english,
): Promise<void> {
  const invite = token
    ? await one<{ id: string; team_id: string; email_key: string; owner_id: string }>(
        `SELECT i.id, i.team_id, i.email_key, t.owner_id FROM team_invites i JOIN teams t ON t.id = i.team_id
         WHERE i.token_hash = ? AND i.expires_at > ?`,
        [sha256(token), now()],
      )
    : null;
  if (!invite) throw new TeamError(t("This invitation has expired or was already used."), 404);
  if (invite.email_key !== emailKey(user.email)) {
    throw new TeamError(t("This invitation was sent to a different email address. Sign in with that address."), 403);
  }
  if (!isVerified(user)) throw new TeamError(t("Confirm your email first, then open the invitation again."), 403, "unverified");
  if (invite.owner_id === user.id) throw new TeamError(t("You own this team."), 409);
  if (await ownTeamPlan(user.id)) throw new TeamError(t("You have your own Business plan, so you can't join another team."), 409);
  if (await one("SELECT 1 FROM team_members WHERE user_id = ?", [user.id])) {
    throw new TeamError(t("You're already on a team. Leave it first."), 409);
  }
  const plan = planById((await ownTeamPlan(invite.owner_id))?.plan);
  if (!plan?.seats) throw new TeamError(t("This team's Business plan isn't active."), 409);
  // This invite's seat becomes the member's, so count members only. The check and the insert are one statement.
  const r = await run(
    `INSERT OR IGNORE INTO team_members (user_id, team_id, joined_at)
     SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM team_members WHERE team_id = ?) < ?`,
    [user.id, invite.team_id, now(), invite.team_id, plan.seats - 1],
  );
  if (r.rowsAffected !== 1) throw new TeamError(t("This team is full."), 409);
  await run("DELETE FROM team_invites WHERE id = ?", [invite.id]);
}

/** The owner removes a member or cancels an invitation. Members can remove themselves (leave). `t` words why it can't. */
export async function removeFromTeam(
  actorId: string,
  target: { userId?: string; inviteId?: string },
  t: Translate = english,
): Promise<void> {
  if (target.userId && target.userId === actorId) {
    await run("DELETE FROM team_members WHERE user_id = ?", [actorId]);
    return;
  }
  const team = await teamOf(actorId);
  if (!team) throw new TeamError(t("Only the team's owner can do this."), 403);
  if (target.userId) await run("DELETE FROM team_members WHERE user_id = ? AND team_id = ?", [target.userId, team.id]);
  if (target.inviteId) await run("DELETE FROM team_invites WHERE id = ? AND team_id = ?", [target.inviteId, team.id]);
}

const monthStart = (t = new Date()) => Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);

/** What the signed-in user sees about their team: the full roster for owners, the pool for members. */
export async function teamSummary(userId: string) {
  const own = await ownTeamPlan(userId);
  const team = await teamOf(userId);
  if (own || team) {
    const plan = planById(own?.plan);
    const members = team
      ? await all<{ id: string; name: string; email: string; joined_at: number; used: number }>(
          `SELECT u.id, u.name, u.email, m.joined_at,
             (SELECT COALESCE(-SUM(l.amount), 0) FROM credit_ledger l
              WHERE l.user_id = ? AND l.actor = u.id AND l.created_at >= ?) AS used
           FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.joined_at`,
          [userId, monthStart(), team.id],
        )
      : [];
    const invites = team
      ? await all<{ id: string; email: string; expires_at: number }>(
          "SELECT id, email, expires_at FROM team_invites WHERE team_id = ? AND expires_at > ? ORDER BY created_at",
          [team.id, now()],
        )
      : [];
    return {
      role: "owner" as const,
      active: Boolean(own),
      seats: plan?.seats ?? 0,
      members: members.map((m) => ({ ...m, used: Number(m.used) })),
      invites,
    };
  }
  const membership = await one<{ owner_id: string; owner_name: string; owner_email: string }>(
    `SELECT t.owner_id, u.name AS owner_name, u.email AS owner_email
     FROM team_members m JOIN teams t ON t.id = m.team_id JOIN users u ON u.id = t.owner_id WHERE m.user_id = ?`,
    [userId],
  );
  if (!membership) return null;
  return {
    role: "member" as const,
    active: Boolean(await teamPool(userId)),
    owner: membership.owner_name || membership.owner_email,
  };
}

export type TeamSummary = Awaited<ReturnType<typeof teamSummary>>;
