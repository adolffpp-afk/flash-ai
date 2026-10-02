"use client";

import { useEffect, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Pricing } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";
import { EngineIcon } from "./EngineIcon";
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
    a: "Leading models from Anthropic (Claude), plus free open-source models from Groq, OpenRouter and Cloudflare. Flash picks one for each request, or you can choose yourself.",
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

  // The main call to action is gold, so it is the one thing on the page that pulls the eye.
  const cta =
    "rounded-xl bg-gold-brand px-6 py-3 font-semibold text-zinc-950 shadow-lg shadow-gold/25 ring-1 ring-gold-soft/60 transition hover:brightness-105 hover:shadow-gold/40";
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <a href="#" aria-label="Flash AI home">
            <Logo size={32} />
          </a>
          <div className="hidden gap-5 text-sm text-zinc-400 sm:flex">
            <a href="#features" className="hover:text-zinc-100">Features</a>
            <a href="#pricing" className="hover:text-zinc-100">Pricing</a>
            <a href="#faq" className="hover:text-zinc-100">FAQ</a>
          </div>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <button onClick={() => onStart("login")} className="rounded-lg px-3 py-2 text-zinc-300 hover:text-white">
              Sign in
            </button>
            <button onClick={() => onStart("signup")} className="rounded-lg bg-brand px-3 py-2 font-medium text-white transition hover:brightness-110">
              Get started
            </button>
          </div>
        </nav>
      </header>

      <section className="relative overflow-hidden">
        {/* Emerald glow, a gold core and one small red spark: the brand in light. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.28),transparent_60%)]" />
          <div className="absolute left-1/2 top-24 h-72 w-72 -translate-x-1/2 rounded-full bg-gold/20 blur-[100px] sm:h-96 sm:w-96" />
          <div className="absolute right-[12%] top-32 h-40 w-40 rounded-full bg-spark/20 blur-[80px]" />
          <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:pt-20">
          <LogoMark size={72} className="mx-auto mb-6 drop-shadow-[0_8px_32px_rgba(245,197,66,0.35)]" />
          <p className="mx-auto flex w-fit items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs text-primary-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-spark shadow-[0_0_8px_2px_rgba(255,69,69,0.6)]" />
            {liveCount ? `${liveCount} AI tools` : "AI tools"} · one app · one bill
          </p>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-white sm:text-6xl">
            One AI for <span className="text-gold-gradient">everything</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-300">
            Build and publish apps, make slides, write, research, code and translate
            {liveMedia.length ? `, and create ${join(liveMedia)}` : ""}. Ask once, and Flash picks the best AI for the
            job.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button onClick={() => onStart("signup")} className={cta}>
              Start free{free ? ` with ${free} credits` : ""}
            </button>
            <a href="#features" className="rounded-xl border border-zinc-700 bg-zinc-950/40 px-5 py-3 text-zinc-100 transition hover:border-primary/60 hover:bg-zinc-900">
              See what it can do
            </a>
          </div>
          <p className="mt-3 text-xs text-zinc-400">No card needed. Free credits every month.</p>

          <div className="mx-auto mt-12 max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 text-left shadow-2xl shadow-primary/10 ring-1 ring-white/5 backdrop-blur">
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md bg-primary-strong px-4 py-2 text-sm text-white">
                Build a booking page for my hair salon in Lagos
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <LogoMark size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-gold">App Builder</span>
                  <span className="text-zinc-500">You asked for an app.</span>
                </div>
                <div className="mt-2 overflow-hidden rounded-xl border border-zinc-800 bg-white text-zinc-900">
                  <div className="bg-gradient-to-r from-rose-100 to-amber-50 px-4 py-3">
                    <div className="text-sm font-semibold">Adé Hair Studio</div>
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
                  <span className="rounded-md border border-zinc-800 px-2 py-1 text-zinc-400">Download</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-16">
        <h2 className="text-center text-3xl font-semibold tracking-tight">Everything you&apos;d use five AI apps for</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-zinc-400">
          A chatbot, an app builder, a slide maker and a research assistant, in one place with one account.
          {soonMedia.length ? ` ${join(soonMedia).replace(/^./, (c) => c.toUpperCase())} ${soonMedia.length > 1 ? "are" : "is"} coming soon.` : ""}
        </p>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ENGINES.map((e) => (
            <div
              key={e}
              className={`rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 transition ${isLive(e) ? "hover:-translate-y-0.5 hover:border-primary/40 hover:bg-zinc-900/70" : "opacity-60"}`}
            >
              <div className="flex items-center gap-3 font-medium">
                <EngineIcon engine={e} />
                {ENGINE_LABELS[e]}
                {!isLive(e) && (
                  <span className="ml-auto rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-zinc-400">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-sm text-zinc-400">{ENGINE_COPY[e].text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-zinc-900 bg-zinc-900/30">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title}>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gold/15 text-sm font-semibold text-gold ring-1 ring-inset ring-gold/30">
                {i + 1}
              </div>
              <h3 className="mt-3 font-medium">{s.title}</h3>
              <p className="mt-1 text-sm text-zinc-400">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-5xl scroll-mt-16 px-4 py-16">
        <h2 className="text-center text-3xl font-semibold tracking-tight">Plans for every maker</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-zinc-400">
          {canBuy
            ? "Start free. Upgrade for more monthly credits, or top up any time. Cancel whenever you like, and unused credits carry over."
            : "Start free with credits every month. Paid plans and top-ups are coming soon."}
        </p>
        <div className="mt-6 flex justify-center">
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
          <div className="mt-8 rounded-xl border border-zinc-800 p-5">
            <h3 className="text-sm font-medium text-zinc-300">Typical credits per request</h3>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3 lg:grid-cols-4">
              {ENGINES.map((e) => (
                <div key={e} className="flex justify-between border-b border-zinc-900 py-1">
                  <span className="text-zinc-400">{ENGINE_LABELS[e]}</span>
                  <span>{isLive(e) ? `${pricing.limits[e] ? "~" : "from "}${pricing.costs[e]}` : <span className="text-zinc-500">soon</span>}</span>
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

      <section id="faq" className="mx-auto max-w-3xl scroll-mt-16 px-4 pb-16">
        <h2 className="text-center text-3xl font-semibold tracking-tight">Questions</h2>
        <div className="mt-8 divide-y divide-zinc-900 rounded-xl border border-zinc-800">
          {faq(liveMedia, soonMedia, canBuy).map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                {f.q}
                <span className="text-gold transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-2 text-sm text-zinc-400">{f.a}</p>
            </details>
          ))}
        </div>
        <div className="mt-12 text-center">
          <button onClick={() => onStart("signup")} className={cta}>
            Try Flash free
          </button>
        </div>
      </section>

      <footer className="border-t border-zinc-900">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-zinc-500 sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} Flash AI</span>
          <div className="flex gap-4 sm:ml-auto">
            <a href="/terms" className="hover:text-zinc-200">Terms</a>
            <a href="/privacy" className="hover:text-zinc-200">Privacy</a>
            <a href="#pricing" className="hover:text-zinc-200">Pricing</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
