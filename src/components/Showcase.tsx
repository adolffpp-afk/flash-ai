"use client";

import { useEffect, useState } from "react";
import { SHOWCASE_EXAMPLES, type ShowcaseExample, type ShowcaseList } from "@/lib/showcase";

/*
 * "Made with Flash" at the foot of the landing page: pictures and apps people made with Flash and
 * chose to share, once the owner of Flash approved them (see server/showcase.ts). Examples drawn on
 * the page fill the apps' row until enough real ones are approved, each marked "Example". In English,
 * like the rest of the landing page.
 */

// How many app cards the row shows: approved apps first, then examples.
const APP_CARDS = 6;

// A little page like the ones Flash builds, drawn on the card itself.
function ExampleCard({ e, phone }: { e: ShowcaseExample; phone: boolean }) {
  return (
    <li className={`glass ${phone ? "" : "max-sm:hidden"} flex flex-col overflow-hidden rounded-3xl shadow-none`}>
      <div className="p-3 pb-0">
        <div aria-hidden className="overflow-hidden rounded-xl bg-paper text-night">
          <div className={`bg-gradient-to-r ${e.from} ${e.to} px-4 py-3`}>
            <div className="text-sm font-semibold">{e.title}</div>
            <div className="text-xs text-[#52525b]">{e.heading}</div>
          </div>
          <div className="grid grid-cols-3 gap-2 p-3 text-[11px]">
            {e.items.map((s) => (
              <div key={s} className="truncate rounded-lg border border-[#e4e4e7] p-2 text-center">
                {s}
              </div>
            ))}
          </div>
          <div className="flex justify-end border-t border-[#f1f1f4] px-3 py-2 text-xs">
            <span className="rounded-md bg-night px-2 py-1 text-paper">{e.button}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[15px] font-medium text-zinc-100">{e.title}</h3>
          <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">Example</span>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">{e.kind}</p>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">&ldquo;{e.prompt}&rdquo;</p>
      </div>
    </li>
  );
}

export function Showcase({ onStart }: { onStart: () => void }) {
  const [list, setList] = useState<ShowcaseList | null>(null);
  useEffect(() => {
    fetch("/api/showcase")
      .then((r) => (r.ok ? r.json() : null))
      .then((l: ShowcaseList | null) => setList(l ?? { sites: [], pictures: [] }))
      .catch(() => setList({ sites: [], pictures: [] }));
  }, []);
  const sites = list?.sites.slice(0, APP_CARDS) ?? [];
  // Until the list loads, the examples hold the row's place, so nothing jumps.
  const examples = SHOWCASE_EXAMPLES.slice(0, Math.max(0, APP_CARDS - sites.length));
  const pictures = list?.pictures ?? [];

  return (
    <section id="showcase" aria-labelledby="showcase-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-24 sm:px-6">
      <h2 id="showcase-title" className="text-center text-2xl font-medium tracking-[-0.025em] sm:text-[2rem]">
        Made with Flash
      </h2>
      <p className="mx-auto mt-4 max-w-xl text-center text-zinc-400">
        Websites, apps and pictures made by asking in plain words. Each one started as a single sentence.
      </p>

      {pictures.length > 0 && (
        <ul className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {pictures.map((p) => (
            <li key={p.id} className="glass aspect-square overflow-hidden rounded-2xl shadow-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/showcase/pictures/${p.id}`} alt={p.title} loading="lazy" className="h-full w-full object-cover" />
            </li>
          ))}
        </ul>
      )}

      <ul className={`${pictures.length ? "mt-3" : "mt-12"} grid gap-3 sm:grid-cols-2 lg:grid-cols-3`}>
        {sites.map((s) => (
          <li key={s.slug} className="glass overflow-hidden rounded-3xl shadow-none transition hover:-translate-y-0.5 hover:brightness-110">
            <a href={`/p/${s.slug}`} target="_blank" rel="noopener" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/p/${s.slug}/card`} alt="" loading="lazy" className="aspect-[1200/630] w-full object-cover" />
              <div className="flex items-center gap-2 p-4">
                <h3 className="min-w-0 flex-1 truncate text-[15px] font-medium text-zinc-100">{s.title}</h3>
                <span className="shrink-0 text-xs text-zinc-400">Open ↗</span>
              </div>
            </a>
          </li>
        ))}
        {/* A phone shows three cards in all, so the page doesn't run on. */}
        {examples.map((e, i) => (
          <ExampleCard key={e.title} e={e} phone={sites.length + i < 3} />
        ))}
      </ul>

      <div className="mt-12 text-center">
        <button
          onClick={onStart}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-brand px-7 text-[15px] font-semibold text-on-brand shadow-[0_10px_30px_-12px_rgb(91_140_246/0.6)] transition hover:brightness-110"
        >
          Make yours with Flash
        </button>
      </div>
    </section>
  );
}
