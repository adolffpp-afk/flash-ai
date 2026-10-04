import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { clientIp } from "@/lib/server/limits.ts";
import { deleteMessage, messageRows, ownsSite, readMessages, receiveMessage } from "@/lib/server/inbox.ts";
import { one } from "@/lib/server/db.ts";
import { csvName, toCsv } from "@/lib/csv.ts";

export const dynamic = "force-dynamic";

// Published sites run on an opaque origin, so sending a form answers any origin and never uses cookies.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** A visitor sends a form to the site's owner (window.flashDB.send). */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/inbox">) {
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { form?: unknown; data?: unknown };
  const result = await receiveMessage(slug, body, clientIp(request), appUrl(request));
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status, headers: CORS });
  return Response.json({ ok: true }, { headers: CORS });
}

/** The owner reads the site's messages in Flash. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/inbox">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: "Not found" }, { status: 404 });
  // ?format=csv downloads them as a spreadsheet file, leaving new ones marked new.
  if (new URL(request.url).searchParams.get("format") === "csv") {
    const site = await one<{ title: string }>("SELECT title FROM sites WHERE slug = ?", [slug]);
    return new Response(toCsv(messageRows(await readMessages(slug, false))), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvName(site?.title ?? "", "messages")}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json({ messages: await readMessages(slug) });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/inbox">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: "Not found" }, { status: 404 });
  await deleteMessage(slug, new URL(request.url).searchParams.get("id") ?? "");
  return Response.json({ ok: true });
}
