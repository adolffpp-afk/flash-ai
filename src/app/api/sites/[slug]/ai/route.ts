import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { clientIp } from "@/lib/server/limits.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { googleTesting, isLighthousePhone } from "@/lib/server/lighthouse.ts";
import { aiSettings, askSiteAi, saveAiSettings } from "@/lib/server/site-ai.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Published apps run on an opaque origin, so asking answers any origin and never uses cookies.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Someone using a published app asks its AI (window.flashAI.ask). The app's owner pays. */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/ai">) {
  const { slug } = await ctx.params;
  // Google's page speed check (Lighthouse) runs the app in a browser, so it could press a button that
  // asks. While Google tests this app (Flash's check, up to about a minute and a half, or one the owner
  // opened on Google's site), and whenever Lighthouse's phone asks, it gets the app's usual "not
  // available" answer and never spends the owner's credits.
  if (isLighthousePhone(request.headers.get("user-agent") ?? "") || (await googleTesting(slug))) {
    return Response.json({ error: "The AI isn't available right now. Please try again later." }, { status: 503, headers: CORS });
  }
  const body = (await request.json().catch(() => ({}))) as { prompt?: unknown; instructions?: unknown };
  const { status, body: answer } = await askSiteAi(slug, body, clientIp(request));
  return Response.json(answer, { status, headers: CORS });
}

/** The owner reads the app's AI settings in Flash. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/ai">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(await aiSettings(slug));
}

/** The owner turns it on or off, and sets how many credits it may use in a day. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/sites/[slug]/ai">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; dailyCredits?: unknown };
  const current = await aiSettings(slug);
  return Response.json(
    await saveAiSettings(
      slug,
      typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      typeof body.dailyCredits === "number" ? body.dailyCredits : current.dailyCredits,
    ),
  );
}
