import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { MAX_SITE_LANGUAGES, removeLanguage, translateOpenTo, translateSite, translationsView } from "@/lib/server/site-translations.ts";
import { siteLanguage } from "@/lib/site-languages.ts";

export const dynamic = "force-dynamic";
// A large site in a dense script is a few calls of up to a couple of minutes, run side by side.
export const maxDuration = 300;

const WINDOW = 10 * 60_000;

/** The app's languages for its owner (Translate my app): what each has, and what translating costs. It calls nothing, so it's free. */
export async function GET(request: Request, ctx: RouteContext<"/api/sites/[slug]/translations">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!translateOpenTo(user)) return Response.json({ error: t("Translate my app is coming soon.") }, { status: 403 });
  const { slug } = await ctx.params;
  const view = await translationsView(user.id, slug);
  if (!view) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json(view);
}

/** Translates the app into one language, or what's new on it since: held at the most it can cost, charged what it used. */
export async function POST(request: Request, ctx: RouteContext<"/api/sites/[slug]/translations">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!translateOpenTo(user)) return Response.json({ error: t("Translate my app is coming soon.") }, { status: 403 });
  const { slug } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { lang?: unknown } | null;
  if (await overLimit(`translate-app:${user.id}`, 60, WINDOW)) {
    return Response.json({ error: t("That's a lot of translating at once. Try again in a few minutes.") }, { status: 429 });
  }
  const r = await translateSite(user, slug, body?.lang);
  if ("ok" in r) return Response.json(r);
  const name = siteLanguage(body?.lang)?.label ?? "";
  const used = r.credits ? " " + t("This used {credits} credits for the work already done.", { credits: r.credits }) : "";
  const errors: Record<typeof r.error, [string, number]> = {
    not_found: [t("Not found"), 404],
    language: [t("Pick a language from the list."), 400],
    same: [t("Your app is already in that language."), 400],
    too_many: [t("An app can be shown in up to {count} languages. Remove one to add another.", { count: MAX_SITE_LANGUAGES }), 400],
    unavailable: [t("Translating isn't available right now. Please try again later."), 503],
    credits: [t("You need more credits to translate into {language}. Get more credits, then try again.", { language: name }), 402],
    failed: [t("Flash couldn't translate that just now. Please try again.") + used, 502],
  };
  const [error, status] = errors[r.error];
  return Response.json({ error, ...(r.error === "credits" && { code: "out_of_credits" }) }, { status });
}

/** Stops showing the app in a language (?lang=…). Its translations go with it. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/sites/[slug]/translations">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { slug } = await ctx.params;
  const lang = new URL(request.url).searchParams.get("lang") ?? "";
  if (!(await removeLanguage(user.id, slug, lang))) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json({ ok: true });
}
