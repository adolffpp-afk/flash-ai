import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { addRecord, listRecords, patchRecord, removeRecord } from "@/lib/server/site-data.ts";

// The public data API behind window.flashDB in published apps. Apps run on an opaque origin,
// so this answers any origin and never uses cookies. These records are shared by everyone using
// the app; each person's own records are in ./mine.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const MINUTE = 60_000;
// Shared records belong to the app, not to a person.
const SHARED = "";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

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
  const { status, body } = await listRecords(slug, q.get("collection") ?? "", q.get("cursor") ?? "", SHARED);
  return json(body, status);
}

export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { collection?: unknown; data?: unknown };
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const answer = await addRecord(slug, body.collection, body.data, SHARED);
  return json(answer.body, answer.status);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { collection?: unknown; id?: unknown; data?: unknown };
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const answer = await patchRecord(slug, body.collection, body.id, body.data, SHARED);
  return json(answer.body, answer.status);
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/data">) {
  const { slug } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const blocked = await limited(request, slug);
  if (blocked) return blocked;
  const answer = await removeRecord(slug, q.get("collection") ?? "", q.get("id") ?? "", SHARED);
  return json(answer.body, answer.status);
}
