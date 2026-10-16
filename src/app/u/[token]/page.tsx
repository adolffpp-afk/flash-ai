import type { Metadata } from "next";
import { headers } from "next/headers";
import { LogoMark } from "@/app/brand";
import { tokenContact } from "@/lib/server/contacts.ts";
import { acceptLanguages, translatorIn } from "@/lib/server/i18n.ts";
import { uiLanguage } from "@/lib/i18n.ts";
import { languageById } from "@/lib/languages.ts";

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ wait?: string }> };

/** The visitor's own language (they have no Flash account), else English. */
async function visitorT() {
  return translatorIn(uiLanguage(undefined, acceptLanguages((await headers()).get("accept-language"))));
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await visitorT();
  // The link is someone's own; search engines have no business with it.
  return { title: t("Unsubscribe"), robots: { index: false, follow: false } };
}

/**
 * Where an app's unsubscribe link goes: someone who got an app's emails stops its news, without
 * signing in. Opening the page changes nothing (link scanners open links too); the button does.
 * It never shows whose link it is, and says only what the app's list shows, as Flash sends no news.
 */
export default async function Unsubscribe({ params, searchParams }: Props) {
  const [{ token }, { wait }, t] = await Promise.all([params, searchParams, visitorT()]);
  const found = await tokenContact(token);
  const site = found?.title ?? "";
  return (
    <div lang={t.language} dir={languageById(t.language)?.rtl ? "rtl" : "ltr"} className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_60%)] px-4 py-16">
      <main className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 text-zinc-100 shadow-[var(--glass-shadow)]">
        <LogoMark size={44} className="mb-4" />
        {!found ? (
          <>
            <h1 className="text-xl font-semibold">{t("This link doesn't work")}</h1>
            <p className="mt-2 text-sm text-zinc-400">{t("It may be old, or the app was removed.")}</p>
          </>
        ) : found.unsubscribed ? (
          <>
            <h1 className="text-xl font-semibold">✓ {t("You're unsubscribed")}</h1>
            <p className="mt-2 text-sm text-zinc-400">{t("{site}'s contact list now shows that you don't want its news by email.", { site })}</p>
          </>
        ) : (
          <form method="post" action={`/api/u/${encodeURIComponent(token)}`}>
            <h1 className="break-words text-xl font-semibold">{t("Stop news emails from {site}?", { site })}</h1>
            <p className="mt-2 text-sm text-zinc-400">{t("{site} will see on its contact list that you don't want its news and offers by email.", { site })}</p>
            {wait && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                {t("Too many tries. Please wait a few minutes.")}
              </p>
            )}
            <button className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-on-brand transition hover:brightness-110">{t("Unsubscribe")}</button>
          </form>
        )}
      </main>
    </div>
  );
}
