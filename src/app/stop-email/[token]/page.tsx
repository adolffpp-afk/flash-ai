import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { LogoMark } from "@/app/brand";
import { tokenAutomation } from "@/lib/server/automation-alerts.ts";
import { acceptLanguages, translatorIn } from "@/lib/server/i18n.ts";
import { uiLanguage } from "@/lib/i18n.ts";
import { languageById } from "@/lib/languages.ts";

type Props = { params: Promise<{ token: string }> };

/** The words its emails were in (their owner's language in Flash), else the browser's (the link works signed out), else English. */
async function readerT(saved?: string) {
  return translatorIn(uiLanguage(saved || undefined, acceptLanguages((await headers()).get("accept-language"))));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await tokenAutomation((await params).token);
  const t = await readerT(found?.language);
  // The link is someone's own; search engines have no business with it.
  return { title: t("Stop these emails"), robots: { index: false, follow: false } };
}

/**
 * Where the "Stop these emails" link of an automation's result email goes: its owner stops them
 * without signing in. Opening the page changes nothing (link scanners open links too); the button does.
 */
export default async function StopEmails({ params }: Props) {
  const { token } = await params;
  const found = await tokenAutomation(token);
  const t = await readerT(found?.language);
  // Isolated in the sentence, so its own direction (an "(AAPL)") stays its own.
  const name = found ? `\u2068${found.name}\u2069` : "";
  return (
    <div lang={t.language} dir={languageById(t.language)?.rtl ? "rtl" : "ltr"} className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_60%)] px-4 py-16">
      <main className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 text-zinc-100 shadow-[var(--glass-shadow)]">
        <LogoMark size={44} className="mb-4" />
        {!found ? (
          <>
            <h1 className="text-xl font-semibold">{t("This link doesn't work")}</h1>
            <p className="mt-2 text-sm text-zinc-400">{t("It may be old, or the automation was deleted.")}</p>
          </>
        ) : !found.emailing ? (
          <>
            <h1 className="break-words text-xl font-semibold">✓ {t("Emails about {name} are off", { name })}</h1>
            <p className="mt-2 text-sm text-zinc-400">{t("Its results are still in Flash, in Automations and the bell. To get them by email again, turn on “Email me each result” in the automation.")}</p>
          </>
        ) : (
          <form method="post" action={`/api/stop-email/${encodeURIComponent(token)}`}>
            <h1 className="break-words text-xl font-semibold">{t("Stop emails about {name}?", { name })}</h1>
            <p className="mt-2 text-sm text-zinc-400">{t("The automation keeps running, and its results stay in Flash, in Automations and the bell.")}</p>
            <button className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-on-brand transition hover:brightness-110">{t("Stop these emails")}</button>
          </form>
        )}
        <p className="mt-6 text-center text-xs text-zinc-500">
          <Link href="/" className="hover:text-zinc-300">
            {t("Open Flash")}
          </Link>
        </p>
      </main>
    </div>
  );
}
