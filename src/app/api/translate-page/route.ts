import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { translateOpenTo } from "@/lib/server/site-translations.ts";
import { fetchPage, importFetchedPage, pagePrice, recentPages, translateFetchedPage, type PageError } from "@/lib/server/page-translations.ts";
import { SITE_LANGUAGES, siteLanguage } from "@/lib/site-languages.ts";

export const dynamic = "force-dynamic";
// Reading the page, then a few calls of up to a couple of minutes, run side by side.
export const maxDuration = 300;

const WINDOW = 10 * 60_000;

/** The languages a page can be translated into, and the user's recent translations. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!translateOpenTo(user)) return Response.json({ error: t("Translate a website is coming soon.") }, { status: 403 });
  return Response.json({
    languages: SITE_LANGUAGES.map((l) => ({ id: l.id, own: l.own, name: l.name })),
    recent: await recentPages(user.id),
  });
}

/**
 * A page by its link: with check, what translating it costs (it's read, nothing is charged); with
 * bring (and own, the owner saying it's their website), made one of their apps in lang; otherwise,
 * translated into lang and kept at a link of its own, held at the most it can cost and charged what it used.
 */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!translateOpenTo(user)) return Response.json({ error: t("Translate a website is coming soon.") }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { url?: unknown; lang?: unknown; check?: unknown; bring?: unknown; own?: unknown } | null;
  if (await overLimit(`translate-page:${user.id}`, 40, WINDOW)) {
    return Response.json({ error: t("That's a lot of translating at once. Try again in a few minutes.") }, { status: 429 });
  }
  const language = siteLanguage(body?.lang);
  const errors: Record<PageError, [string, number]> = {
    link: [t("Paste the link of a public web page, like https://example.com."), 400],
    fetch: [t("Flash couldn't open that page. Check the link, or try again in a moment."), 422],
    not_html: [t("That link isn't a web page Flash can translate."), 422],
    empty: [t("Flash found no words to translate on that page. Pages that only show their words once their scripts run can't be translated yet."), 422],
    language: [t("Pick a language from the list."), 400],
    same: [t("That page is already in that language."), 400],
    unavailable: [t("Translating isn't available right now. Please try again later."), 503],
    credits: [t("You need more credits to translate into {language}. Get more credits, then try again.", { language: language?.label ?? "" }), 402],
    failed: [t("Flash couldn't translate that just now. Please try again."), 502],
  };
  const fail = (error: PageError) => Response.json({ error: errors[error][0], ...(error === "credits" && { code: "out_of_credits" }) }, { status: errors[error][1] });

  if (body?.bring && body.own !== true) return Response.json({ error: t("Confirm it's your own website to bring it into Flash.") }, { status: 400 });

  const page = await fetchPage(body?.url);
  if ("error" in page) return fail(page.error);
  if (body?.check) {
    const price = pagePrice(page, language?.id ?? "am");
    return Response.json({ url: page.url, title: page.title, phrases: page.phrases.length, from: page.from?.id ?? "", ...price });
  }
  if (body?.bring) {
    const made = await importFetchedPage(user, page, body.lang, t);
    if (!("error" in made)) return Response.json({ ...made, link: `/p/${made.slug}?lang=${encodeURIComponent(made.lang)}` });
    if ("status" in made) return Response.json({ error: made.error, ...(made.code && { code: made.code }) }, { status: made.status });
    return fail(made.error);
  }
  const done = await translateFetchedPage(user, page, body?.lang, t);
  if ("error" in done) return fail(done.error);
  return Response.json({ ...done, link: `/t/${done.id}` });
}
