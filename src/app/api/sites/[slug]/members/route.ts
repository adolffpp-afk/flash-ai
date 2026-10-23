import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { one } from "@/lib/server/db.ts";
import { listSiteUsers, removeSiteUser } from "@/lib/server/site-auth.ts";
import { appAccess, chooseAccess, invite, isTeamRole, listInvites, uninvite } from "@/lib/server/site-team.ts";
import { csvName, toCsv } from "@/lib/csv.ts";

export const dynamic = "force-dynamic";

/** The people signed up to a published app, for its owner. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/members">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  // Each person's role is the one they were invited with; "" for people who signed up by themselves.
  const invites = await listInvites(slug);
  const roles = new Map(invites.map((i) => [i.email, i.role]));
  const members = (await listSiteUsers(slug)).map((m) => ({ ...m, role: roles.get(m.email.toLowerCase()) ?? "" }));
  if (new URL(request.url).searchParams.get("format") === "csv") {
    const site = await one<{ title: string }>("SELECT title FROM sites WHERE slug = ?", [slug]);
    const rows = [
      [t("Joined"), t("Email"), t("Name")],
      ...members.map((m) => [new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " "), m.email, m.name]),
    ];
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvName(site?.title ?? "", "members")}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json({ members, invites, ...(await appAccess(slug)) });
}

/**
 * The owner chooses who may sign in ({ access: "anyone" | "invited" | "" }), or invites addresses
 * with a role ({ invite: ["a@b.co", …], role: "member" | "manager" }), which also changes the role of
 * someone invited before.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/members">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { access?: unknown; invite?: unknown; role?: unknown };
  if (body.access !== undefined) {
    if (body.access !== "anyone" && body.access !== "invited" && body.access !== "") return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 400 });
    await chooseAccess(slug, body.access);
  }
  if (body.invite !== undefined) {
    const emails = Array.isArray(body.invite) ? body.invite.filter((e): e is string => typeof e === "string").slice(0, 200) : [];
    const done = await invite(slug, emails, isTeamRole(body.role) ? body.role : "member");
    if ("error" in done) {
      const error = done.error === "full" ? t("An app can have up to {count} invited people.", { count: "2,000" }) : t("Please check the email addresses.");
      return Response.json({ error }, { status: 400 });
    }
  }
  return Response.json({ invites: await listInvites(slug), ...(await appAccess(slug)) });
}

/** The owner removes someone, with their private data. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/members">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const q = new URL(request.url).searchParams;
  // Taking an invitation back: in an app open only to invited people, they can't sign in any more.
  const email = q.get("invite");
  if (email !== null) return Response.json({ ok: await uninvite(slug, email), invites: await listInvites(slug) });
  const id = q.get("id") ?? "";
  // Someone removed is uninvited too, so they can't simply sign up again.
  const member = await one<{ email: string }>("SELECT email FROM site_users WHERE site_slug = ? AND id = ?", [slug, id]);
  if (member) await uninvite(slug, member.email);
  return Response.json({ ok: await removeSiteUser(slug, id) });
}
