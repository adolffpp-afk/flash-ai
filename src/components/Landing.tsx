"use client";

import { useEffect, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Pricing } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";
import { EngineIcon } from "./EngineIcon";
import { InstallApp } from "./InstallApp";
import { BrandMark } from "@/app/brand";
import { Orb } from "./Home";

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
    a: "Chat, writing, code and translation keep working on free models, with a daily allowance. App building and web research need credits, and your free credits refill on the 1st of each month.",
  },
  {
    q: "Can I change or cancel my plan?",
    a: "Yes. Cancel from the credits panel and your plan runs to the end of the period you paid for. Switching to another plan starts a new month that day, and you keep the credits you already have.",
  },
  {
    q: "Which AI models does Flash use?",
    a: "Flash has four levels of intelligence, all on Anthropic's Claude: Flash Sonic for quick answers, Flash Ascend for everyday work, Flash Vision for apps and code, and Flash Summit for the hardest work. On Auto, Flash picks the level for each request, or you can choose yourself. When your credits run out, free models from Groq, Google Gemini, OpenRouter and Cloudflare keep answering.",
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

  // The main call to action, in the same colours as the app's main buttons.
  const cta =
    "inline-flex h-12 items-center gap-2 rounded-full bg-brand px-7 text-[15px] font-semibold text-on-brand shadow-[0_10px_30px_-12px_rgb(91_140_246/0.6)] transition hover:brightness-110";
  return (
    // No background of its own: the app's page glow (iridescent by day, Nova glass at night) shows through.
    <div className="h-full overflow-y-auto text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-white/6 bg-zinc-950/60 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-4 sm:px-6">
          <a href="#" aria-label="Flash AI home" className="flex items-center gap-1.5">
            <span className="[filter:drop-shadow(0_3px_8px_rgb(91_140_246/0.35))]">
              <BrandMark size={34} id="flash-landing" />
            </span>
            <span className="whitespace-nowrap text-[19px] font-bold leading-none tracking-tight text-white">
              FLASH <span className="font-light">AI</span>
            </span>
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
            <button onClick={() => onStart("signup")} className="h-9 rounded-full bg-brand px-4 font-medium text-on-brand transition hover:brightness-110">
              Get started
            </button>
          </div>
        </nav>
      </header>

      <section className="relative overflow-hidden">
        {/* The iridescent wash of Home's hero: cyan, violet and pink light behind the orb. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-x-0 top-0 h-[42rem] bg-iris-wash opacity-80 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" />
          <div className="absolute left-[12%] top-24 h-72 w-72 rounded-full bg-cyan-300/20 blur-[110px] light:bg-cyan-200/50" />
          <div className="absolute right-[12%] top-40 h-72 w-72 rounded-full bg-fuchsia-300/15 blur-[110px] light:bg-pink-200/50" />
        </div>
        <div className="relative mx-auto max-w-3xl px-4 pb-24 pt-14 text-center sm:px-6 sm:pt-20">
          <Orb className="mx-auto mb-10 w-36 sm:w-48" />
          <p className="glass mx-auto flex w-fit items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-zinc-300 shadow-none">
            <span className="h-1.5 w-1.5 rounded-full bg-spark" />
            {liveCount ? `${liveCount} AI tools` : "AI tools"} · one app · one bill
          </p>
          <h1 className="mt-6 text-[2.6rem] font-bold leading-[1.04] tracking-[-0.04em] text-white sm:text-[4.25rem]">
            One AI for <span className="text-iris">everything</span>
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
            <a href="#features" className="glass inline-flex h-12 items-center rounded-full px-7 text-[15px] text-zinc-200 shadow-none transition hover:brightness-110">
              See what it can do
            </a>
          </div>
          <p className="mt-4 text-xs text-zinc-500">No card needed. Free credits every month.</p>

          <div className="glass-raised mx-auto mt-16 max-w-2xl rounded-[28px] p-4 text-left sm:p-5">
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md border border-white/10 bg-zinc-800 px-4 py-2 text-sm text-zinc-50">
                Build a booking page for my hair salon in Toronto
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <BrandMark size={28} id="flash-demo" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-white/10 px-2 py-0.5 text-zinc-300">App Builder</span>
                  <span className="text-zinc-500">You asked for an app.</span>
                </div>
                <div className="mt-2 overflow-hidden rounded-xl bg-paper text-night">
                  <div className="bg-gradient-to-r from-rose-100 to-amber-50 px-4 py-3">
                    <div className="text-sm font-semibold">Elaia Hair Studio</div>
                    <div className="text-xs text-[#52525b]">Book your next appointment</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 p-3 text-xs">
                    {["Braids · 2h", "Cut · 45m", "Colour · 1h30"].map((s) => (
                      <div key={s} className="rounded-lg border border-[#e4e4e7] p-2 text-center">{s}</div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t border-[#f1f1f4] px-3 py-2 text-xs">
                    <span className="text-[#71717a]">Saturday, 10:30</span>
                    <span className="rounded-md bg-night px-2 py-1 text-paper">Book</span>
                  </div>
                </div>
                <div className="mt-2 flex gap-2 text-xs">
                  <span className="rounded-md bg-brand px-2 py-1 text-on-brand">Publish</span>
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
              className={`glass rounded-3xl p-5 shadow-none transition ${isLive(e) ? "hover:-translate-y-0.5 hover:brightness-110" : "opacity-60"}`}
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
          <div className="glass mt-10 rounded-3xl p-5 shadow-none sm:p-6">
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
        <div className="glass mt-10 divide-y divide-white/6 rounded-3xl shadow-none">
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
