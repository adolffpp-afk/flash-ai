"use client";

import { useEffect, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Pricing } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";
import { EngineIcon } from "./EngineIcon";
import { InstallApp } from "./InstallApp";
import { Showcase } from "./Showcase";
import { BrandMark, Wordmark } from "@/app/brand";
import { ICONS, Orb, Tile, type Hue } from "./Home";
import { msg } from "@/lib/i18n";
import { LEGAL_NAME, TRADEMARK } from "@/lib/product";
import { useT } from "@/lib/use-t";
import { useInAndroidApp } from "@/lib/android-shell";
import { localPrice } from "@/lib/local-currency";
import { useLocalCurrency } from "@/lib/use-local-currency";

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

// What Create makes, worded for the media tools that are live (pictures and video share a provider, as do music and voice).
const CREATE_TEXT = {
  all: msg("Pictures, video, music and voice-overs from a few words."),
  pictures: msg("Pictures and video from a few words."),
  sound: msg("Music and voice-overs from a few words."),
};

// How many of the tools a phone shows before "Show all".
const PHONE_TOOLS = 6;

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
      ? "No. The free plan gives you credits every month. Plans give you more credits each month for less per credit, and you can cancel any time. You can also buy one-off top-ups. Up to 2 months of unused plan credits carry over, and bought credits don't expire."
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
  // The landing page shows in English (see Flash.tsx); its newer words are in the tables all the same.
  const t = useT();
  const inApp = useInAndroidApp();
  const [pricing, setPricing] = useState<Pricing | null>(initialPricing ?? null);
  const local = useLocalCurrency();
  const [billing, setBilling] = useState<Interval>("month");
  // Phones show the first few tools until this is pressed, so the page isn't one long column of cards.
  const [allTools, setAllTools] = useState(false);
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
  const pictures = isLive("image") && isLive("video");
  const sound = isLive("music") && isLive("voice");

  // The seven things Flash is for, each with what it does today. Automate is planned, not built, so it says so.
  const pillars: { name: string; text: string; d: string; hue: Hue; live: boolean }[] = [
    { name: t("Chat"), text: t("Ask anything by typing or talking, and get answers in your language."), d: ICONS.chat, hue: "blue", live: isLive("text") },
    {
      name: t("Research"),
      text: t("Flash searches the web for you and writes up what it finds, citing each source."),
      d: ICONS.search,
      hue: "pink",
      live: isLive("search"),
    },
    {
      name: t("Create"),
      text: t(pictures && !sound ? CREATE_TEXT.pictures : sound && !pictures ? CREATE_TEXT.sound : CREATE_TEXT.all),
      d: ICONS.create,
      hue: "orange",
      live: pictures || sound,
    },
    {
      name: t("Build"),
      text: t("Working apps and websites from a description, with a live preview you change by chatting."),
      d: ICONS.app,
      hue: "violet",
      live: isLive("app"),
    },
    {
      name: t("Host"),
      text: t("Published apps run on Flash, with their own database, a form inbox and visitor stats."),
      d: ICONS.globe,
      hue: "teal",
      live: isLive("app"),
    },
    {
      name: t("Deploy"),
      text: pricing?.domainsEnabled
        ? t("Publish in one click to a Flash address, or to your own domain on a paid plan.")
        : t("Publish in one click and get a link anyone can open. Update it any time."),
      d: ICONS.share,
      hue: "rose",
      live: isLive("app"),
    },
    {
      name: t("Automate"),
      text: t("Set up a job once, like a weekly sales summary, and Flash will run it on time."),
      d: ICONS.bolt,
      hue: "blue",
      live: false,
    },
  ];

  // The main call to action, in the same colours as the app's main buttons.
  const cta =
    "inline-flex h-12 items-center gap-2 rounded-full bg-brand px-7 text-[15px] font-semibold text-on-brand shadow-[0_10px_30px_-12px_rgb(91_140_246/0.6)] transition hover:brightness-110";
  return (
    // No background of its own: the app's page glow (iridescent by day, Nova glass at night) shows through.
    <div className="h-full overflow-y-auto text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-white/6 bg-zinc-950/60 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6 md:gap-8">
          <a href="#" aria-label={t("Flash Infinity AI, home")} className="flex shrink-0 items-center gap-2">
            <span className="[filter:drop-shadow(0_3px_8px_rgb(91_140_246/0.35))]">
              <BrandMark size={34} id="flash-landing" />
            </span>
            <Wordmark tm className="text-[19px] font-bold leading-none tracking-tight text-white" />
          </a>
          <div className="hidden gap-6 text-sm text-zinc-400 sm:flex">
            <a href="#features" className="hover:text-zinc-100">Features</a>
            {!inApp && <a href="#pricing" className="hover:text-zinc-100">Pricing</a>}
            <a href="#faq" className="hover:text-zinc-100">FAQ</a>
            <a href="#showcase" className="hover:text-zinc-100">Showcase</a>
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
        <div className="relative mx-auto max-w-3xl px-4 pb-16 pt-10 text-center sm:px-6 sm:pb-24 sm:pt-20">
          <Orb className="mx-auto mb-7 w-28 sm:mb-10 sm:w-48" />
          <p className="glass mx-auto flex w-fit items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-zinc-300 shadow-none">
            <span className="h-1.5 w-1.5 rounded-full bg-spark" />
            {liveCount ? `${liveCount} AI tools` : "AI tools"} · one app · one bill
          </p>
          {/* The tagline, one sentence to a line. */}
          <h1 className="mt-6 text-[2.5rem] font-bold leading-[1.04] tracking-[-0.04em] text-white sm:text-[3.75rem] lg:text-[4.25rem]">
            <span className="block">{t("One Workspace.")}</span>
            <span className="block text-iris">{t("Infinite Possibilities.")}</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
            Build and publish apps, make slides, write, research, code and translate
            {liveMedia.length ? `, and create ${join(liveMedia)}` : ""}. Ask once, and Flash picks the best AI for the
            job.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row">
            <button onClick={() => onStart("signup")} className={cta}>
              Start free{free ? ` with ${free} credits` : ""}
            </button>
            <a href="#features" className="glass inline-flex h-12 items-center rounded-full px-7 text-[15px] text-zinc-200 shadow-none transition hover:brightness-110">
              See what it can do
            </a>
          </div>
          <p className="mt-4 text-xs text-zinc-500">No card needed. Free credits every month.</p>

          <div className="glass-raised mx-auto mt-12 max-w-2xl sm:mt-16 rounded-[28px] p-4 text-left sm:p-5">
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

      <section id="product" aria-labelledby="product-title" className="mx-auto max-w-6xl scroll-mt-16 px-4 sm:px-6">
        <h2 id="product-title" className="text-center text-2xl font-medium tracking-[-0.025em] sm:text-[2rem]">
          {t("All in one workspace")}
        </h2>
        {/* Two to a row on a phone, four on a wide screen with the last three centred under them. */}
        <ul className="mt-8 flex flex-wrap justify-center gap-3 sm:mt-12">
          {pillars.map((p) => (
            <li
              key={p.name}
              className={`glass w-[calc(50%-0.375rem)] rounded-3xl p-4 shadow-none sm:p-5 lg:w-[calc(25%-0.5625rem)] ${p.live ? "" : "opacity-60"}`}
            >
              <div className="flex flex-wrap items-center gap-3 gap-y-2">
                <Tile d={p.d} hue={p.hue} size="sm" />
                <h3 className="text-[15px] font-medium text-zinc-100">{p.name}</h3>
                {!p.live && (
                  <span className="ms-auto whitespace-nowrap rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-zinc-400">
                    {t("Coming soon")}
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-[13px] leading-snug text-zinc-400 sm:text-sm sm:leading-relaxed">{p.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-16 sm:px-6 sm:py-24">
        <h2 className="text-center text-2xl font-medium tracking-[-0.025em] sm:text-[2rem]">Everything you&apos;d use five AI apps for</h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-zinc-400">
          A chatbot, an app builder, a slide maker and a research assistant, in one place with one account.
          {soonMedia.length ? ` ${join(soonMedia).replace(/^./, (c) => c.toUpperCase())} ${soonMedia.length > 1 ? "are" : "is"} coming soon.` : ""}
        </p>
        <div className="mt-8 grid grid-cols-2 gap-3 sm:mt-12 lg:grid-cols-3">
          {ENGINES.map((e, i) => (
            <div
              key={e}
              className={`glass rounded-3xl p-4 shadow-none transition sm:p-5 ${isLive(e) ? "hover:-translate-y-0.5 hover:brightness-110" : "opacity-60"} ${i >= PHONE_TOOLS && !allTools ? "max-sm:hidden" : ""}`}
            >
              <div className="flex flex-wrap items-center gap-3 gap-y-2 text-[15px] font-medium text-zinc-100">
                <EngineIcon engine={e} />
                {ENGINE_LABELS[e]}
                {!isLive(e) && (
                  <span className="ml-auto whitespace-nowrap rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-zinc-400">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-[13px] leading-snug text-zinc-400 sm:text-sm sm:leading-relaxed">{ENGINE_COPY[e].text}</p>
            </div>
          ))}
        </div>
        {!allTools && ENGINES.length > PHONE_TOOLS && (
          <div className="mt-4 flex justify-center sm:hidden">
            <button onClick={() => setAllTools(true)} className="glass inline-flex h-11 items-center rounded-full px-6 text-sm text-zinc-200 shadow-none transition hover:brightness-110">
              Show all {ENGINES.length} tools
            </button>
          </div>
        )}
      </section>

      <section className="border-y border-white/6">
        <div className="mx-auto grid max-w-6xl gap-7 px-4 py-14 sm:grid-cols-3 sm:gap-10 sm:px-6 sm:py-20">
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

      {/* Nothing is for sale inside the Android app (Play's billing rule, see android-shell.ts). */}
      {!inApp && (
        <section id="pricing" className="mx-auto max-w-5xl scroll-mt-16 px-4 py-16 sm:px-6 sm:py-24">
          <h2 className="text-center text-2xl font-medium tracking-[-0.025em] sm:text-[2rem]">Plans for every maker</h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-zinc-400">
            {canBuy
              ? "Start free. Upgrade for more monthly credits, or top up any time. Cancel whenever you like, and up to 2 months of unused credits carry over."
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
              {pricing.packs.map((p) => {
                const about = localPrice(p.priceCents, local);
                return `${p.credits.toLocaleString("en-US")} credits for ${money(p.priceCents)}${about ? ` (about ${about})` : ""}`;
              }).join(" · ")}.
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
      )}

      <section id="faq" className="mx-auto max-w-3xl scroll-mt-16 px-4 pb-16 sm:px-6 sm:pb-24">
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
      </section>

      {/* At the foot of the page: what people made with Flash, ending on the call to start. */}
      <Showcase onStart={() => onStart("signup")} />

      <footer className="border-t border-white/6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 sm:px-6 text-sm text-zinc-500 sm:flex-row sm:items-center">
          {/* The company that runs Flash. The name ends in a full stop, so the line has none of its own. */}
          <div className="flex flex-col gap-1">
            <span>
              © {new Date().getFullYear()} {LEGAL_NAME}
            </span>
            <span className="text-xs">{t.node("{product} is operated by {company}", { product: <Wordmark />, company: LEGAL_NAME })}</span>
            <span className="text-xs">{t("{brand} is a trademark of {company}", { brand: TRADEMARK, company: LEGAL_NAME })}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 sm:ml-auto">
            <a href="/terms" className="hover:text-zinc-200">Terms</a>
            <a href="/privacy" className="hover:text-zinc-200">Privacy</a>
            <a href="#pricing" className="hover:text-zinc-200">Pricing</a>
            <a href="/report" className="hover:text-zinc-200">{t("Report content")}</a>
            <InstallApp className="flex items-center gap-1.5 hover:text-zinc-200" />
          </div>
        </div>
      </footer>
    </div>
  );
}
