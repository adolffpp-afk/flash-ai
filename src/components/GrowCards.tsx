"use client";

import { msg } from "@/lib/i18n";
import { useT } from "@/lib/use-t";
import { Icon } from "./Home";

/*
 * "Grow what you build", under "Everything an app needs": three big cards on a grained Flash-coloured
 * backdrop, each a tool that helps a published app get found and used, with a round arrow that opens it
 * (or sign-up, on the landing page). Only tools Flash has today: the search check with Fix all, the
 * social post pack in your brand, and each app's visitors and funnel.
 */
export type GrowCard = "seo" | "social" | "analytics";

const CARDS: { id: GrowCard; title: string; text: string }[] = [
  {
    id: "seo",
    title: msg("Search check"),
    text: msg("Get found on Google. Flash checks each page of your app, lists what to fix first, and makes the fixes for you with Fix all."),
  },
  {
    id: "social",
    title: msg("Social posts"),
    text: msg("Posts and hashtags for Instagram, TikTok and Facebook, with pictures in your brand's colours and logo, ready to share."),
  },
  {
    id: "analytics",
    title: msg("App analytics"),
    text: msg("See visits, where people came from, and each step from first visit to order, for every app you publish."),
  },
];

// Fine grain over the backdrop, drawn by the browser (no picture to download).
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E\")";

export function GrowCards({ onOpen, className = "" }: { onOpen: (card: GrowCard) => void; className?: string }) {
  const t = useT();
  return (
    <section aria-labelledby="grow-title" className={`mx-auto max-w-[1300px] px-4 sm:px-6 ${className}`}>
      <h2 id="grow-title" className="mb-6 text-[clamp(28px,4vw,48px)] font-bold leading-[1.05] tracking-[-0.035em] text-white sm:mb-8">
        {t("Grow what you build.")}
      </h2>
      <div className="relative overflow-hidden rounded-[28px] bg-[radial-gradient(120%_90%_at_0%_100%,#6d5bd0_0%,transparent_55%),radial-gradient(90%_80%_at_100%_0%,#2fd9bd_0%,transparent_50%),radial-gradient(80%_80%_at_55%_60%,#1e2547_0%,#0d1124_75%)] p-3 sm:p-6">
        <div aria-hidden className="pointer-events-none absolute inset-0 mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
        {/* On a phone the cards sit side by side and swipe, so they take one screen's height, not three. */}
        <ul className="relative flex snap-x snap-mandatory gap-3 overflow-x-auto [scrollbar-width:none] sm:gap-5 md:grid md:grid-cols-3 md:overflow-visible">
          {CARDS.map((c) => (
            <li key={c.id} className="flex min-h-[260px] w-[82%] shrink-0 snap-start flex-col rounded-2xl bg-[#f7f6fb] p-6 text-[#0d1124] shadow-xl sm:min-h-[340px] sm:w-[60%] sm:p-7 md:w-auto lg:min-h-[400px]">
              <h3 className="max-w-[10ch] text-[clamp(26px,2.6vw,36px)] font-semibold leading-[1.08] tracking-[-0.025em]">{t(c.title)}</h3>
              <p className="mt-auto pt-6 text-[15px] sm:pt-10 sm:text-[16px] leading-relaxed text-[#3b3f55]">{t(c.text)}</p>
              <button
                onClick={() => onOpen(c.id)}
                aria-label={t(c.title)}
                className="mt-8 flex h-12 w-12 items-center justify-center rounded-full bg-[#0d1124] text-[#ffffff] transition hover:bg-[#6d5bd0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6d5bd0]"
              >
                <Icon d="M7 17 17 7 M9 7h8v8" className="h-5 w-5 rtl:-scale-x-100" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
