"use client";

import { useState } from "react";
import { BrandMark } from "@/app/brand";
import { msg } from "@/lib/i18n";
import { useT } from "@/lib/use-t";
import { Icon } from "./Home";
import { ShowcaseMockup } from "./ShowcaseMockups";

/*
 * "Everything an app needs" under the rolling strip, on the landing page and Home: a big headline and
 * a picture on one side, and on the other what every Flash app gets without any setup, a row each,
 * opening like a menu to show all it holds. Only what Flash does today.
 */
const ROWS = [
  {
    title: msg("Database and file storage, built in"),
    items: [msg("Data saved for every app"), msg("Files people send, kept with the app"), msg("Rules for who may see or change each kind of data"), msg("Download your records any time")],
    text: msg("Every app keeps its own data and the files people send it. You choose who may see or change each kind of data."),
  },
  {
    title: msg("Connect the tools you use"),
    items: [msg("Google Drive"), msg("GitHub"), msg("Live web search"), msg("Public company and economic data")],
    text: msg("Link Google Drive, GitHub and more in a few taps, so Flash can read your files and work with your accounts."),
  },
  {
    title: msg("Your own address"),
    items: [msg("A free Flash link for every app"), msg("Your own domain on a paid plan"), msg("The picture shown when your link is shared"), msg("Earlier versions kept, ready to bring back")],
    text: msg("Publish to a Flash link in one click. On a paid plan, show your app on your own domain, like yourbakery.com."),
  },
  {
    title: msg("Visitors and sales, counted"),
    items: [msg("Visits and visitors by day"), msg("Where your visitors came from"), msg("Steps from first visit to order"), msg("A search check with what to fix")],
    text: msg("See who visits, where they came from, and which visits turn into messages, sign-ups and orders."),
  },
  {
    title: msg("Get paid through your app"),
    items: [msg("Sell items with Stripe"), msg("Orders, refunds and disputes in one place"), msg("A contact list of everyone who paid")],
    text: msg("Sell from your app with Stripe. Orders, refunds and disputes show up in your app's dashboard."),
  },
  {
    title: msg("Safe by default"),
    items: [msg("Two-step sign-in"), msg("Sign-up and sign-in for your app's members"), msg("Private data stays private")],
    text: msg("Two-step sign-in for your account, sign-in for your app's members, and rules that keep private data private."),
  },
  {
    title: msg("The best AI for each job"),
    items: [msg("Claude, Gemini, Mistral and more"), msg("Auto picks the best one for each request"), msg("Let your app use AI, with a daily budget you set")],
    text: msg("Claude, Gemini, Mistral and more in one place. Flash picks the right one for each request, so you don't have to."),
  },
];

export function StackSection({ className = "" }: { className?: string }) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section aria-labelledby="stack-title" className={`mx-auto grid max-w-[1300px] gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16 ${className}`}>
      <div className="flex flex-col">
        <h2 id="stack-title" className="text-[clamp(34px,5vw,64px)] font-bold leading-[1] tracking-[-0.04em] text-white">
          <span className="block">{t("Everything an app needs.")}</span>
          <span className="block text-iris">{t("Already inside.")}</span>
        </h2>
        <p className="mt-5 max-w-md text-[16px] leading-relaxed text-zinc-300">
          {t("Describe it and publish it, without renting a server, setting up a database or wiring up payments. It's all there from the start.")}
        </p>
        {/* The picture: Flash's mark on its own tile beside one of the apps it builds. */}
        <div aria-hidden className="mt-8 grid max-w-[520px] grid-cols-[0.8fr_1.2fr] overflow-hidden rounded-2xl lg:mt-auto">
          <div className="flex items-center justify-center bg-[linear-gradient(135deg,#222944,#0d1124)] p-6 [&>svg]:h-auto [&>svg]:w-full">
            <BrandMark size={160} id="flash-stack" />
          </div>
          <div className="bg-[#eef2ff] p-3">
            <ShowcaseMockup id="dashboard" />
          </div>
        </div>
      </div>
      <ul className="divide-y divide-white/15 border-b border-white/15 lg:border-t-0">
        {ROWS.map((r, i) => (
          <li key={r.title}>
            <button
              onClick={() => setOpen(open === i ? null : i)}
              aria-expanded={open === i}
              className="group flex w-full items-center gap-4 py-5 text-start sm:py-6"
            >
              <span className="min-w-0 flex-1 text-[clamp(20px,2.6vw,34px)] font-semibold leading-tight tracking-[-0.02em] text-white">{t(r.title)}</span>
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-white/70 text-white transition group-hover:bg-white group-hover:text-zinc-950 sm:h-12 sm:w-12 ${open === i ? "rotate-90" : ""}`}
              >
                <Icon d="M5 12h14 M13 6l6 6-6 6" className="h-5 w-5 rtl:-scale-x-100" />
              </span>
            </button>
            {open === i && (
              <div className="-mt-1 pb-6">
                <p className="max-w-xl text-[16px] leading-relaxed text-zinc-300">{t(r.text)}</p>
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {r.items.map((item) => (
                    <li key={item} className="glass flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[15px] text-zinc-100 shadow-none">
                      <Icon d="M5 12l5 5 9-10" className="h-4 w-4 shrink-0 text-primary-soft" />
                      {t(item)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
