import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { one } from "@/lib/server/db.ts";
import { chooseRule, newestShared, removeRecord, sharedCollections, sharedCsv } from "@/lib/server/site-data.ts";
import { COLLECTION, DEFAULT_KEY, OWNER, isDataRule } from "@/lib/data-rules.ts";
import { csvName } from "@/lib/csv.ts";
import type { Translate } from "@/lib/i18n.ts";

export const dynamic = "force-dynamic";

// My websites & apps › Data: what a published app keeps in its shared data, and who may change it.
// For the app's owner only, signed in to Flash. Custom domains can't reach this (see site-host.ts).

const notFound = (t: Translate) => Response.json({ error: t("Not found") }, { status: 404 });

/**
 * The app's collections with their rules. With ?collection=x, that collection's newest 100 records,
 * and with &format=csv as well, all of them as a file (cut before 4 MB, newest first).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/records">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return notFound(t);
  const q = new URL(request.url).searchParams;
  const collection = q.get("collection");
  if (collection === null) {
    const data = await sharedCollections(slug);
    return data ? Response.json(data) : notFound(t);
  }
  if (!COLLECTION.test(collection)) return Response.json({ error: t("Invalid collection name.") }, { status: 400 });
  if (q.get("format") !== "csv") return Response.json({ records: await newestShared(slug, collection) });
  const { csv, included, total } = await sharedCsv(slug, collection, t);
  const site = await one<{ title: string }>("SELECT title FROM sites WHERE slug = ?", [slug]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvName(site?.title ?? "", collection.toLowerCase())}"`,
      "Cache-Control": "no-store",
      ...(included < total && { "X-Flash-Truncated": `${included}/${total}` }),
    },
  });
}

/** The owner chooses who may change a collection ("*" for anything else), or null to go back to the app's choice. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/records">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return notFound(t);
  const body = (await request.json().catch(() => ({}))) as { collection?: unknown; rule?: unknown };
  const collection = typeof body.collection === "string" ? body.collection : "";
  const rule = body.rule === null ? null : isDataRule(body.rule) ? body.rule : undefined;
  if ((collection !== DEFAULT_KEY && !COLLECTION.test(collection)) || rule === undefined || !(await chooseRule(slug, collection, rule))) {
    return Response.json({ error: t("Pick one of the choices.") }, { status: 400 });
  }
  return Response.json(await sharedCollections(slug));
}

/** The owner deletes one shared record. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/records">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return notFound(t);
  const q = new URL(request.url).searchParams;
  const { status, body } = await removeRecord(slug, q.get("collection") ?? "", q.get("id") ?? "", "", OWNER);
  return Response.json(body, { status });
}
