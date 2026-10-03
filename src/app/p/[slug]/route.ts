import { one } from "@/lib/server/db.ts";
import { flashDbShim, injectHead } from "@/lib/flashdb-shim.ts";

// Published apps are served with a CSP sandbox, which gives them their own opaque origin:
// they can't read Flash's cookies or call Flash's private APIs, only the public flashDB endpoint.
// They still share Flash's domain (phishing pages would too), so publishing needs a confirmed
// email and is rate limited. TODO: serve them from a separate domain once one is bought.
const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";

export async function GET(_request: Request, ctx: RouteContext<"/p/[slug]">) {
  const { slug } = await ctx.params;
  const site = await one<{ html: string }>("SELECT html FROM sites WHERE slug = ?", [slug]);
  if (!site) {
    return new Response("<!doctype html><title>Not found</title><p style='font-family:sans-serif'>This app doesn't exist or was unpublished.</p>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const html = injectHead(site.html, flashDbShim(`/api/sites/${slug}/data`));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SANDBOX_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
}
