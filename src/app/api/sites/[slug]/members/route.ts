import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { one } from "@/lib/server/db.ts";
import { listSiteUsers, removeSiteUser } from "@/lib/server/site-auth.ts";
import { csvName, toCsv } from "@/lib/csv.ts";

export const dynamic = "force-dynamic";

/** The people signed up to a published app, for its owner. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/members">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const members = await listSiteUsers(slug);
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
  return Response.json({ members });
}

/** The owner removes someone, with their private data. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/members">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return Response.json({ ok: await removeSiteUser(slug, id) });
}
