"use client";

import { useEffect, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Pricing } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

const ENGINE_COPY: Record<Engine, { icon: string; text: string }> = {
  app: { icon: "🛠️", text: "Describe an app and get a working one, with a live preview, its own database and one-click publishing." },
  slides: { icon: "🖥️", text: "A polished presentation from one sentence. Click or swipe through it, then download it." },
  text: { icon: "✍️", text: "Emails, posts, plans and answers, written in your voice and remembering what matters to you." },
  search: { icon: "🔎", text: "Up-to-date answers from the web, with the sources linked so you can check them." },
  code: { icon: "💻", text: "Write, explain and fix code in any language, with copy and download buttons." },
  translate: { icon: "🌍", text: "Natural translations that keep your tone, in dozens of languages." },
  docs: { icon: "📊", text: "Budgets, tables, resumes and reports, ready to download as spreadsheets and documents." },
  image: { icon: "🎨", text: "Logos, posters and lifelike photos from the best image models." },
  video: { icon: "🎬", text: "Short cinematic clips, including video with sound, speech and music." },
  voice: { icon: "🔊", text: "Natural-sounding voiceovers for any text." },
  music: { icon: "🎵", text: "Jingles, beats and full songs with sung lyrics." },
  transcribe: { icon: "📝", text: "Clean transcripts from any recording or video." },
};

const STEPS = [
  { title: "Ask in plain words", text: "Type what you want, or drop in a file. No menus to learn." },
  { title: "Flash picks the best AI", text: "Each request goes to the model that does that job best, automatically." },
  { title: "Keep, download or publish", text: "Everything is saved in your projects. Apps go live with one click." },
];

const FAQ = [
  {
    q: "What is Flash?",
    a: "One app that brings together the best AI for each job: writing, research, code, apps, slides, images, video, music, voice and transcripts. You ask once and Flash sends the request to the right model.",
  },
  {
    q: "Do I need to know how to code to build an app?",
    a: "No. Describe what you want, like \"a booking page for my salon\", and Flash builds it. Keep chatting to change it, then press Publish to get a link you can share.",
  },
  {
    q: "How do credits work?",
    a: "Every account gets free credits each month. Each request uses credits based on what it costs to make: a short chat answer uses a few, an app or a video uses more. You always see the cost on each reply, and failed requests are free.",
  },
  {
    q: "Do I need a subscription?",
    a: "No. The free plan gives you credits every month. Plans give you more credits each month for less per credit, and you can cancel any time. You can also buy one-off top-ups. Unused plan credits carry over, and bought credits don't expire.",
  },
  {
    q: "What happens when my credits run out?",
    a: "Chat, writing, code and translation keep working on free open-source models, with a daily allowance, and you can make a few free images a day. App building, video, music, voice and web research need credits.",
  },
  {
    q: "Can I change or cancel my plan?",
    a: "Yes. Cancel from the credits panel and your plan runs to the end of the period you paid for. Switching to another plan starts a new month that day, and you keep the credits you already have.",
  },
  {
    q: "Which AI models does Flash use?",
    a: "Leading models from Anthropic (Claude), OpenAI, ElevenLabs and Google, Black Forest Labs, Kuaishou and MiniMax through fal.ai. Flash picks one for each request, or you can choose yourself.",
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

export function Landing({ onStart }: { onStart: (mode: "signup" | "login") => void }) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [billing, setBilling] = useState<Interval>("month");
  useEffect(() => {
    api<Pricing>("/api/pricing").then(setPricing).catch(() => {});
  }, []);
  const free = pricing?.freeMonthly;

  const cta =
    "rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-5 py-3 font-medium text-white shadow-lg shadow-fuchsia-500/20 transition hover:brightness-110";
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <a href="#" className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-pink-500">⚡</span>
            Flash AI
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
            <button onClick={() => onStart("signup")} className="rounded-lg bg-white px-3 py-2 font-medium text-zinc-900 hover:bg-zinc-200">
              Get started
            </button>
          </div>
        </nav>
      </header>

      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.25),transparent_60%)]" />
        <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-16 text-center sm:pt-24">
          <p className="mx-auto inline-flex rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-300">
            12 AI tools · one app · one bill
          </p>
          <h1 className="mt-6 bg-gradient-to-b from-white to-zinc-400 bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-6xl">
            One AI for everything
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-400">
            Build and publish apps, make slides, write, research, code and translate, and create images, video, music
            and voice. Ask once, and Flash picks the best AI for the job.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button onClick={() => onStart("signup")} className={cta}>
              Start free{free ? ` with ${free} credits` : ""}
            </button>
            <a href="#features" className="rounded-xl border border-zinc-800 px-5 py-3 text-zinc-200 hover:bg-zinc-900">
              See what it can do
            </a>
          </div>
          <p className="mt-3 text-xs text-zinc-500">No card needed. Free credits every month.</p>

          <div className="mx-auto mt-12 max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-left shadow-2xl shadow-black/40">
            <div className="flex justify-end">
              <div className="rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2 text-sm">
                Build a booking page for my hair salon in Lagos
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-pink-500 text-xs">⚡</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">App Builder</span>
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
                  <span className="rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-2 py-1 text-white">Publish</span>
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
          A chatbot, an app builder, a slide maker, an image and video studio and a music and voice studio, in one
          place with one account.
        </p>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ENGINES.map((e) => (
            <div key={e} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center gap-2 font-medium">
                <span aria-hidden>{ENGINE_COPY[e].icon}</span>
                {ENGINE_LABELS[e]}
              </div>
              <p className="mt-1.5 text-sm text-zinc-400">{ENGINE_COPY[e].text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-zinc-900 bg-zinc-900/30">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title}>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/15 text-sm font-semibold text-indigo-300">
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
          Start free. Upgrade for more monthly credits, or top up any time. Cancel whenever you like, and unused
          credits carry over.
        </p>
        <div className="mt-6 flex justify-center">
          <IntervalToggle value={billing} onChange={setBilling} />
        </div>
        {pricing && (
          <div className="mt-8">
            <PlanCards pricing={pricing} interval={billing} onFree={() => onStart("signup")} onPick={() => onStart("signup")} />
          </div>
        )}
        {pricing && (
          <p className="mt-4 text-center text-sm text-zinc-400">
            Need more? Top up any time:{" "}
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
                  <span>{pricing.limits[e] ? "~" : "from "}{pricing.costs[e]}</span>
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
          {FAQ.map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between font-medium">
                {f.q}
                <span className="text-zinc-500 transition group-open:rotate-45">+</span>
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
