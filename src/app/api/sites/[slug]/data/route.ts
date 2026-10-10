import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { addRecord, listRecords, patchRecord, removeRecord, type Answer } from "@/lib/server/site-data.ts";
import { callerFor, ownerKeyEnded } from "@/lib/server/site-owner.ts";
import type { Caller } from "@/lib/data-rules.ts";

// The public data API behind window.flashDB in published apps. Apps run on an opaque origin,
// so this answers any origin and never uses cookies. These records are shared by everyone using
// the app; each person's own records are in ./mine. What each caller may do depends on the
// collection's rule (see data-rules.ts). A request carries the key Flash put into the page, if any:
// the owner's key (on a page opened with Open as owner), or the key of the person signed in to the app.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const MINUTE = 60_000;
// Shared records belong to the app, not to a person.
const SHARED = "";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
/** The answer, saying when it was refused because the owner's key had ended, so the owner's page can tell them. */
const reply = ({ status, body }: Answer, request: Request, caller: Caller) =>
  json(status >= 400 && ownerKeyEnded(request.headers.get("authorization"), caller) ? { ...(body as object), ownerEnded: true } : body, status);

/** Anyone can call this API, so each visitor and each app gets a request budget. */
export async function limited(request: Request, slug: string): Promise<Response | null> {
  if ((await overLimit(`flashdb-ip:${clientIp(request)}`, 120, MINUTE)) || (await overLimit(`flashdb-site:${slug}`, 1200, MINUTE))) {
    return json({ error: "Too many requests. Please wait a minute." }, 429);
  }
  return null;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const caller = await callerFor(slug, request.headers.get("authorization"));
  return reply(await listRecords(slug, q.get("collection") ?? "", q.get("cursor") ?? "", SHARED, caller), request, caller);
}

export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const caller = await callerFor(slug, request.headers.get("authorization"));
  const body = (await request.json().catch(() => ({}))) as { collection?: unknown; data?: unknown };
  return reply(await addRecord(slug, body.collection, body.data, SHARED, caller), request, caller);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const caller = await callerFor(slug, request.headers.get("authorization"));
  const body = (await request.json().catch(() => ({}))) as { collection?: unknown; id?: unknown; data?: unknown };
  return reply(await patchRecord(slug, body.collection, body.id, body.data, SHARED, caller), request, caller);
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const caller = await callerFor(slug, request.headers.get("authorization"));
  return reply(await removeRecord(slug, q.get("collection") ?? "", q.get("id") ?? "", SHARED, caller), request, caller);
}
