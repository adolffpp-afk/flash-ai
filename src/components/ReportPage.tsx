"use client";

import Link from "next/link";
import { useState } from "react";
import { LogoMark, Wordmark } from "@/app/brand";
import { ReportForm } from "@/components/ReportForm";
import { useBrowserLanguage, useT } from "@/lib/use-t";

/**
 * The public Report content page (/report): anyone can paste the address of a shared chat, a file
 * or an app made with Flash, on Flash's address or the app's own domain, and say what's wrong.
 * Published apps are their owners' own sites, so Flash adds no Report button to them; this page is
 * how they're reported. Its words follow the browser's language.
 */
export function ReportPage() {
  const t = useT();
  useBrowserLanguage();
  // Report another page starts a fresh form.
  const [round, setRound] = useState(0);
  return (
    <div className="min-h-full text-zinc-100">
      <div className="mx-auto max-w-xl px-4 py-10">
        <Link href="/" className="flex w-fit items-center gap-2 text-sm font-semibold">
          <LogoMark size={28} />
          <Wordmark tm />
        </Link>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight">{t("Report content")}</h1>
        <p className="mt-3 leading-relaxed text-zinc-300">
          {t("Seen something on a Flash page, or in an app made with Flash, that shouldn't be there? Paste its address and tell us what's wrong.")}
        </p>
        <p className="mt-2 text-sm text-zinc-500">{t("Reports go only to the Flash team, never to the person who made it.")}</p>
        <div className="mt-6 rounded-2xl border border-white/8 bg-zinc-900/60 p-5 sm:p-6">
          <ReportForm
            key={round}
            t={t}
            after={
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setRound((r) => r + 1)}
                  className="h-10 rounded-full bg-brand px-5 text-sm font-medium text-on-brand transition hover:brightness-110"
                >
                  {t("Report another page")}
                </button>
                <Link href="/" className="text-sm text-primary-soft underline-offset-2 hover:underline">
                  {t("Back to Flash")}
                </Link>
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
