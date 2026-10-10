import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { clientIp, overLimit } from "@/lib/server/limits.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { deleteUpload, listUploads, saveUpload, setUploadsOn, uploadsOn, uploadUse, MAX_UPLOAD_BYTES } from "@/lib/server/site-files.ts";
import { visitorForPageToken } from "@/lib/server/site-auth.ts";

export const dynamic = "force-dynamic";

// Published apps run on an opaque origin, so uploading answers any origin and never uses cookies.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const HOUR = 3600_000;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Someone using a published app sends it a file (window.flashDB.upload). */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/files">) {
  const { slug } = await ctx.params;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 4096) {
    return Response.json({ error: "Files must be 5 MB or smaller." }, { status: 413, headers: CORS });
  }
  if (await overLimit(`site-upload:${clientIp(request)}`, 20, HOUR)) {
    return Response.json({ error: "You've sent a lot of files just now. Please wait a few minutes." }, { status: 429, headers: CORS });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file was sent." }, { status: 400, headers: CORS });
  // A file sent by someone signed in to the app belongs to them, so it goes when they do.
  const who = await visitorForPageToken(slug, request.headers.get("authorization"));
  const { status, body } = await saveUpload(
    slug,
    { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) },
    who?.id ?? "",
  );
  return Response.json(body, { status, headers: CORS });
}

/** The owner sees what the app holds. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/files">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json({ files: await listUploads(slug), use: await uploadUse(slug), enabled: await uploadsOn(slug) });
}

/** The owner lets the app take files, or stops it. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/files">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return Response.json({ error: t("Say whether it's on.") }, { status: 400 });
  return Response.json({ enabled: await setUploadsOn(slug, body.enabled) });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/files">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return Response.json({ ok: await deleteUpload(slug, id) });
}
