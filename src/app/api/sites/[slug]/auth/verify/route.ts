import { confirmVerifyLink } from "@/lib/server/site-verify.ts";

export const dynamic = "force-dynamic";

/**
 * The link Flash emails to prove an address (see site-verify.ts). It works once, then sends the
 * person to the app to sign in, with a note the app shows (flashAuth.error).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/auth/verify">) {
  const { slug } = await ctx.params;
  const ok = await confirmVerifyLink(slug, new URL(request.url).searchParams.get("t") ?? "");
  return new Response(null, {
    status: 303,
    headers: { Location: `/p/${slug}?flash_auth=${ok ? "verified" : "link-expired"}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
