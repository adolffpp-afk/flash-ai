"use client";

import { useEffect, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Pricing } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";
import { EngineIcon } from "./EngineIcon";
import { InstallApp } from "./InstallApp";
import { Logo, LogoMark } from "@/app/brand";

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

const ENGINE_COPY: Record<Engine, { text: string }> = {
  app: { text: "Describe an app and get a working one, with a live preview, its own database and one-click publishing." },
  slides: { text: "A polished presentation from one sentence. Click or swipe through it, then download it." },
  text: { text: "Emails, posts, plans and answers, written in your voice and remembering what matters to you." },
  search: { text: "Up-to-date answers from the web, with the sources linked so you can check them." },
  code: { text: "Write, explain and fix code in any language, with copy and download buttons." },
  translate: { text: "Natural translations that keep your tone, in dozens of languages." },
  docs: { text: "Budgets, tables, resumes and reports, ready to download as spreadsheets and documents." },
  image: { text: "Logos, posters and lifelike photos from the best image models." },
  video: { text: "Short cinematic clips, including video with sound, speech and music." },
  voice: { text: "Natural-sounding voiceovers for any text." },
  music: { text: "Jingles, beats and full songs with sung lyrics." },
  transcribe: { text: "Clean transcripts from any recording or video." },
};

const STEPS = [
  { title: "Ask in plain words", text: "Type what you want, or drop in a file. No menus to learn." },
  { title: "Flash picks the best AI", text: "Each request goes to the model that does that job best, automatically." },
  { title: "Keep, download or publish", text: "Everything is saved in your projects. Apps go live with one click." },
];

// Lists words the way a sentence would: "a", "a and b", "a, b and c".
const join = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? ""));

// What the media engines make, in the order the copy lists them.
const MEDIA_WORDS: [Engine, string][] = [
  ["image", "images"],
  ["video", "video"],
  ["music", "music"],
  ["voice", "voice"],
  ["transcribe", "transcripts"],
];

/** The questions and answers, worded for the engines that are live and whether plans are on sale. */
const faq = (live: string[], soon: string[], canBuy: boolean) => [
  {
    q: "What is Flash?",
    a: `One app that brings together the best AI for each job: ${join(["writing", "research", "code", "apps", "slides", "translation", ...live])}. ${soon.length ? `${join(soon).replace(/^./, (c) => c.toUpperCase())} ${soon.length > 1 ? "are" : "is"} coming soon. ` : ""}You ask once and Flash sends the request to the right model.`,
  },
  {
    q: "Do I need to know how to code to build an app?",
    a: "No. Describe what you want, like \"a booking page for my salon\", and Flash builds it. Keep chatting to change it, then press Publish to get a link you can share.",
  },
  {
    q: "How do credits work?",
    a: "Every account gets free credits each month. Each request uses credits based on what it costs to make: a short chat answer uses a few, an app uses more. You always see the cost on each reply, and failed requests are free.",
  },
  {
    q: "Do I need a subscription?",
    a: canBuy
      ? "No. The free plan gives you credits every month. Plans give you more credits each month for less per credit, and you can cancel any time. You can also buy one-off top-ups. Unused plan credits carry over, and bought credits don't expire."
      : "No. The free plan gives you credits every month, with no card needed. Paid plans and top-ups are coming soon.",
  },
  {
    q: "What happens when my credits run out?",
    a: "Chat, writing, code and translation keep working on free open-source models, with a daily allowance. App building and web research need credits, and your free credits refill on the 1st of each month.",
  },
  {
    q: "Can I change or cancel my plan?",
    a: "Yes. Cancel from the credits panel and your plan runs to the end of the period you paid for. Switching to another plan starts a new month that day, and you keep the credits you already have.",
  },
  {
    q: "Which AI models does Flash use?",
    a: "Flash has four levels of intelligence, all on Anthropic's Claude: Flash Sonic for quick answers, Flash Ascend for everyday work, Flash Vision for apps and code, and Flash Ultra for the hardest work. On Auto, Flash picks the level for each request, or you can choose yourself. When your credits run out, free open-source models from Groq, OpenRouter and Cloudflare keep answering.",
  },
  {
    q: "Who owns what I make?",
    a: "You do. You can use your text, images, apps and media for personal or commercial projects, subject to our terms and the law.",
  },
  {
    q: "Is my data private?",
    a: "Your projects are visible only to you, unless you publish an app. Requests are sent to the AI provider that answers them and are not used by Flash to train models. See the privacy policy for details.",
  },
];

export function Landing({
  onStart,
  status,
  initialPricing,
}: {
  onStart: (mode: "signup" | "login") => void;
  // Which engines are live; the others are marked coming soon. Null while unknown.
  status: Record<Engine, boolean> | null;
  initialPricing?: Pricing;
}) {
  const [pricing, setPricing] = useState<Pricing | null>(initialPricing ?? null);
  const [billing, setBilling] = useState<Interval>("month");
  useEffect(() => {
    if (!initialPricing) api<Pricing>("/api/pricing").then(setPricing).catch(() => {});
  }, [initialPricing]);
  const free = pricing?.freeMonthly;
  const isLive = (e: Engine) => !status || status[e];
  const liveCount = status ? ENGINES.filter((e) => status[e]).length : 0;
  const liveMedia = MEDIA_WORDS.filter(([e]) => isLive(e)).map(([, word]) => word);
  const soonMedia = MEDIA_WORDS.filter(([e]) => !isLive(e)).map(([, word]) => word);
  // Until the prices load, plans are assumed to be on sale so nothing flickers to "coming soon".
  const canBuy = !pricing || pricing.paymentsEnabled || pricing.testPurchases;

  // The main call to action is holographic, so it is the one thing on the page that pulls the eye.
  const cta =
    "inline-flex h-11 items-center rounded-full bg-holo px-6 text-sm font-medium text-zinc-950 shadow-[0_6px_24px_-8px_rgba(188,196,246,0.45)] ring-1 ring-inset ring-white/50 transition hover:brightness-105";
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-white/6 bg-zinc-950/70 backdrop-blur-md">
        <nav className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-4 sm:px-6">
          <a href="#" aria-label="Flash AI home">
            <Logo size={28} className="text-[15px]" />
          </a>
          <div className="hidden gap-6 text-sm text-zinc-400 sm:flex">
            <a href="#features" className="hover:text-zinc-100">Features</a>
            <a href="#pricing" className="hover:text-zinc-100">Pricing</a>
            <a href="#faq" className="hover:text-zinc-100">FAQ</a>
          </div>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <InstallApp className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-zinc-300 transition hover:text-white sm:flex" />
            <button onClick={() => onStart("login")} className="h-9 rounded-full px-3 text-zinc-300 transition hover:text-white">
              Sign in
            </button>
            <button onClick={() => onStart("signup")} className="h-9 rounded-full bg-brand px-4 font-medium text-white transition hover:brightness-110">
              Get started
            </button>
          </div>
        </nav>
      </header>

      <section className="relative overflow-hidden">
        {/* A quiet emerald wash with a faint holographic halo: light, not a light show. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.16),transparent_60%)]" />
          <div className="absolute left-1/2 top-28 h-72 w-[36rem] max-w-full -translate-x-1/2 rounded-full bg-holo-lavender/8 blur-[110px]" />
          <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_65%)]" />
        </div>
        <div className="relative mx-auto max-w-3xl px-4 pb-24 pt-16 text-center sm:px-6 sm:pt-28">
          <LogoMark size={76} className="mx-auto mb-8" />
          <p className="mx-auto flex w-fit items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-xs text-zinc-300">
            <span className="h-1.5 w-1.5 rounded-full bg-spark" />
            {liveCount ? `${liveCount} AI tools` : "AI tools"} · one app · one bill
          </p>
          <h1 className="mt-6 text-4xl font-medium leading-[1.08] tracking-[-0.035em] text-white sm:text-[3.5rem]">
            One AI for <span className="text-holo">everything</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
            Build and publish apps, make slides, write, research, code and translate
            {liveMedia.length ? `, and create ${join(liveMedia)}` : ""}. Ask once, and Flash picks the best AI for the
            job.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button onClick={() => onStart("signup")} className={cta}>
              Start free{free ? ` with ${free} credits` : ""}
            </button>
            <a href="#features" className="inline-flex h-11 items-center rounded-full border border-white/10 px-6 text-sm text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04]">
              See what it can do
            </a>
          </div>
          <p className="mt-4 text-xs text-zinc-500">No card needed. Free credits every month.</p>

          <div className="mx-auto mt-16 max-w-2xl rounded-2xl border border-white/8 bg-zinc-900/50 p-4 text-left shadow-[0_24px_60px_-30px_rgba(0,0,0,0.8)] backdrop-blur sm:p-5">
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md bg-primary-strong px-4 py-2 text-sm text-white">
                Build a booking page for my hair salon in Toronto
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <LogoMark size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-white/10 px-2 py-0.5 text-zinc-300">App Builder</span>
                  <span className="text-zinc-500">You asked for an app.</span>
                </div>
                <div className="mt-2 overflow-hidden rounded-xl bg-white text-zinc-900">
                  <div className="bg-gradient-to-r from-rose-100 to-amber-50 px-4 py-3">
                    <div className="text-sm font-semibold">Elaia Hair Studio</div>
                    <div className="text-xs text-zinc-600">Book your next appointment</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 p-3 text-xs">
                    {["Braids · 2h", "Cut · 45m", "Colour · 1h30"].map((s) => (
                      <div key={s} className="rounded-lg border border-zinc-200 p-2 text-center">{s}</div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t border-zinc-100 px-3 py-2 text-xs">
                    <span className="text-zinc-500">Saturday, 10:30</span>
                    <span className="rounded-md bg-zinc-900 px-2 py-1 text-white">Book</span>
                  </div>
                </div>
                <div className="mt-2 flex gap-2 text-xs">
                  <span className="rounded-md bg-brand px-2 py-1 text-white">Publish</span>
                  <span className="rounded-md border border-white/10 px-2 py-1 text-zinc-400">Download</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-24 sm:px-6">
        <h2 className="text-center text-2xl font-medium tracking-[-0.025em] sm:text-[2rem]">Everything you&apos;d use five AI apps for</h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-zinc-400">
          A chatbot, an app builder, a slide maker and a research assistant, in one place with one account.
          {soonMedia.length ? ` ${join(soonMedia).replace(/^./, (c) => c.toUpperCase())} ${soonMedia.length > 1 ? "are" : "is"} coming soon.` : ""}
        </p>
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ENGINES.map((e) => (
            <div
              key={e}
              className={`rounded-xl border border-white/6 bg-white/[0.02] p-5 transition ${isLive(e) ? "hover:border-white/12 hover:bg-white/[0.035]" : "opacity-60"}`}
            >
              <div className="flex items-center gap-3 text-[15px] font-medium text-zinc-100">
                <EngineIcon engine={e} />
                {ENGINE_LABELS[e]}
                {!isLive(e) && (
                  <span className="ml-auto rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-zinc-400">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-sm leading-relaxed text-zinc-400">{ENGINE_COPY[e].text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-white/6">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:grid-cols-3 sm:px-6">
          {STEPS.map((s, i) => (
            <div key={s.title}>
              <div className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium text-gold ring-1 ring-inset ring-gold/30">
                {i + 1}
              </div>
              <h3 className="mt-3 font-medium">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-5xl scroll-mt-16 px-4 py-24 sm:px-6">
        <h2 className="text-center text-2xl font-medium tracking-[-0.025em] sm:text-[2rem]">Plans for every maker</h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-zinc-400">
          {canBuy
            ? "Start free. Upgrade for more monthly credits, or top up any time. Cancel whenever you like, and unused credits carry over."
            : "Start free with credits every month. Paid plans and top-ups are coming soon."}
        </p>
        <div className="mt-8 flex justify-center">
          <IntervalToggle value={billing} onChange={setBilling} />
        </div>
        {pricing && (
          <div className="mt-8">
            <PlanCards
              pricing={pricing}
              interval={billing}
              onFree={() => onStart("signup")}
              onPick={() => onStart("signup")}
              comingSoon={!canBuy}
            />
          </div>
        )}
        {pricing && (
          <p className="mt-4 text-center text-sm text-zinc-400">
            {canBuy ? "Need more? Top up any time: " : "Top-ups, coming soon: "}
            {pricing.packs.map((p) => `${p.credits.toLocaleString("en-US")} credits for ${money(p.priceCents)}`).join(" · ")}.
            Bought credits never expire.
          </p>
        )}
        {pricing && (
          <div className="mt-10 rounded-xl border border-white/6 p-5 sm:p-6">
            <h3 className="text-sm font-medium text-zinc-300">Typical credits per request</h3>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3 lg:grid-cols-4">
              {ENGINES.map((e) => (
                <div key={e} className="flex justify-between border-b border-white/5 py-1.5">
                  <span className="text-zinc-400">{ENGINE_LABELS[e]}</span>
                  <span className="text-zinc-300">{isLive(e) ? `${pricing.limits[e] ? "~" : "from "}${pricing.costs[e]}` : <span className="text-zinc-500">soon</span>}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Writing, research, code, apps and slides are charged by length. Every reply shows what it used, and
              failed requests are free.
            </p>
          </div>
        )}
      </section>

      <section id="faq" className="mx-auto max-w-3xl scroll-mt-16 px-4 pb-24 sm:px-6">
        <h2 className="text-center text-2xl font-medium tracking-[-0.025em] sm:text-[2rem]">Questions</h2>
        <div className="mt-10 divide-y divide-white/6 rounded-xl border border-white/6">
          {faq(liveMedia, soonMedia, canBuy).map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] text-zinc-100">
                {f.q}
                <span className="text-lg font-light text-zinc-500 transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{f.a}</p>
            </details>
          ))}
        </div>
        <div className="mt-16 text-center">
          <button onClick={() => onStart("signup")} className={cta}>
            Try Flash free
          </button>
        </div>
      </section>

      <footer className="border-t border-white/6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 sm:px-6 text-sm text-zinc-500 sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} Flash AI</span>
          <div className="flex gap-4 sm:ml-auto">
            <a href="/terms" className="hover:text-zinc-200">Terms</a>
            <a href="/privacy" className="hover:text-zinc-200">Privacy</a>
            <a href="#pricing" className="hover:text-zinc-200">Pricing</a>
            <InstallApp className="flex items-center gap-1.5 hover:text-zinc-200" />
          </div>
        </div>
      </footer>
    </div>
  );
}
