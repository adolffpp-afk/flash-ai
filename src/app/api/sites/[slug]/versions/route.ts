import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { listVersions, restoreVersion, versionHtml } from "@/lib/server/sites.ts";
import { flashDbShim, injectHead } from "@/lib/flashdb-shim.ts";

export const dynamic = "force-dynamic";

/**
 * The site's earlier versions. With ?view=<id>, that version's page, sandboxed like a published
 * site and with a stand-in flashDB, so looking at it never touches the live site's data.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/versions">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const view = new URL(request.url).searchParams.get("view");
  if (view) {
    const html = await versionHtml(slug, view);
    if (html === null) return new Response(t("This version was deleted."), { status: 404 });
    return new Response(injectHead(html, flashDbShim(null)), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json({ versions: await listVersions(slug) });
}

/** Puts an earlier version live again, and says what that changes for who may see or change its data. */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/versions">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  const restored = typeof id === "string" ? await restoreVersion(user.id, slug, id) : null;
  if (!restored) return Response.json({ error: t("That version was deleted.") }, { status: 404 });
  return Response.json({ ok: true, ...(restored.data && { data: restored.data }) });
}
