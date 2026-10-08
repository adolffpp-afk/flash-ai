import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { addRecord, listRecords, patchRecord, removeRecord } from "@/lib/server/site-data.ts";
import { visitorForPageToken } from "@/lib/server/site-auth.ts";

// One person's own records in a published app (window.flashDB.mine), kept apart from the app's
// shared data. The app sends the key Flash put into its page; cookies never work here, because a
// published app has no origin of its own.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const MINUTE = 60_000;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** The signed-in visitor this request is for, or the answer to send back instead. */
async function visitor(request: Request, slug: string): Promise<{ id: string } | Response> {
  if ((await overLimit(`flashdb-ip:${clientIp(request)}`, 120, MINUTE)) || (await overLimit(`flashdb-site:${slug}`, 1200, MINUTE))) {
    return json({ error: "Too many requests. Please wait a minute." }, 429);
  }
  const who = await visitorForPageToken(slug, request.headers.get("authorization"));
  if (!who) return json({ error: "Sign in to this app first." }, 401);
  return who;
}

export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/mine">) {
  const { slug } = await ctx.params;
  const who = await visitor(request, slug);
  if (who instanceof Response) return who;
  const q = new URL(request.url).searchParams;
  const { status, body } = await listRecords(slug, q.get("collection") ?? "", q.get("cursor") ?? "", who.id);
  return json(body, status);
}

export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/mine">) {
  const { slug } = await ctx.params;
  const who = await visitor(request, slug);
  if (who instanceof Response) return who;
  const body = (await request.json().catch(() => ({}))) as { collection?: unknown; data?: unknown };
  const answer = await addRecord(slug, body.collection, body.data, who.id);
  return json(answer.body, answer.status);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/mine">) {
  const { slug } = await ctx.params;
  const who = await visitor(request, slug);
  if (who instanceof Response) return who;
  const body = (await request.json().catch(() => ({}))) as { collection?: unknown; id?: unknown; data?: unknown };
  const answer = await patchRecord(slug, body.collection, body.id, body.data, who.id);
  return json(answer.body, answer.status);
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/mine">) {
  const { slug } = await ctx.params;
  const who = await visitor(request, slug);
  if (who instanceof Response) return who;
  const q = new URL(request.url).searchParams;
  const answer = await removeRecord(slug, q.get("collection") ?? "", q.get("id") ?? "", who.id);
  return json(answer.body, answer.status);
}
