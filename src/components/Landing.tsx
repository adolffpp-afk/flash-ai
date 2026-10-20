"use client";

import { useEffect, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Pricing } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";
import { EngineIcon } from "./EngineIcon";
import { InstallApp } from "./InstallApp";
import { Showcase } from "./Showcase";
import { BrandMark, Wordmark } from "@/app/brand";
import { ICONS, Icon, Orb, Tile, type Hue } from "./Home";
import { RollingShowcase } from "./RollingShowcase";
import { StackSection } from "./StackSection";
import { GrowCards } from "./GrowCards";
import { keepIdea } from "@/lib/idea-keep";
import { useTypingPlaceholder } from "@/lib/use-typing";
import { TYPED_IDEAS } from "@/lib/showcase";
import { createLine } from "@/lib/features";
import { LEGAL_NAME, SUPPORT_EMAIL, TRADEMARK } from "@/lib/product";
import { useT } from "@/lib/use-t";
import { useInAndroidApp } from "@/lib/android-shell";
import { localPrice } from "@/lib/local-currency";
import { useLocalCurrency } from "@/lib/use-local-currency";
import { FREE_SITES, PLAN_SITES } from "@/lib/plan-limits";

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
  // Every plan, under "Choose your plan", once "See all plans" is pressed.
  const [allPlans, setAllPlans] = useState(false);
  // The top bar's menu, and what the visitor types in the message box (kept for after they sign up).
  const [menuOpen, setMenuOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const [mode, setMode] = useState<"app" | "auto" | "image" | "video" | "search">("app");
  const [boxFocused, setBoxFocused] = useState(false);
  const typed = useTypingPlaceholder([...TYPED_IDEAS], !idea && !boxFocused);
  useEffect(() => {
    if (!initialPricing) api<Pricing>("/api/pricing").then(setPricing).catch(() => {});
  }, [initialPricing]);
  const free = pricing?.freeMonthly;
  const isLive = (e: Engine) => !status || status[e];
  const liveMedia = MEDIA_WORDS.filter(([e]) => isLive(e)).map(([, word]) => word);
  const soonMedia = MEDIA_WORDS.filter(([e]) => !isLive(e)).map(([, word]) => word);
  // Until the prices load, plans are assumed to be on sale so nothing flickers to "coming soon".
  const canBuy = !pricing || pricing.paymentsEnabled || pricing.testPurchases;
  // The least a paid plan costs a month, billed yearly (plans for one person; team plans cost more).
  const cheapest = pricing ? Math.min(...pricing.plans.filter((p) => !p.seats).map((p) => p.yearlyPriceCents)) : 0;
  // The footer's columns: only pages Flash has. Nothing is for sale inside the Android app, so no Pricing there.
  const footerColumns: [string, [string, string][]][] = [
    ["Product", [["#features", "Features"], ...(inApp ? [] : ([["#pricing", "Pricing"]] as [string, string][])), ["#showcase", "Showcase"], ["/connector", "Use Flash in Claude"]]],
    ["Resources", [["#faq", "Questions"], [`mailto:${SUPPORT_EMAIL}`, "Help"]]],
    ["Company", [[`mailto:${SUPPORT_EMAIL}`, "Contact us"]]],
    ["Legal", [["/terms", "Terms"], ["/privacy", "Privacy"], ["/delete-account", "Delete your account"]]],
  ];

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
      // Worded for the media tools that are live (createLine).
      text: t(createLine(isLive)),
      d: ICONS.create,
      hue: "orange",
      live: isLive("image") || isLive("video") || (isLive("music") && isLive("voice")),
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

  return (
    // No background of its own: the app's page glow (iridescent by day, Nova glass at night) shows through.
    <div className="h-full overflow-y-auto text-zinc-100">
      {/* A slim bar, as in the simplest app builders: the logo on the left; Start building and the menu on the right. */}
      <header className="sticky top-0 z-20 bg-zinc-950/60 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          <a href="#" aria-label={t("Flash Infinity AI, home")} className="flex shrink-0 items-center gap-2">
            <BrandMark size={34} id="flash-landing" />
            <Wordmark tm className="text-[20px] font-bold leading-none tracking-tight text-white" />
          </a>
          <div className="relative ms-auto flex items-center gap-2 text-sm">
            <button onClick={() => onStart("signup")} className="h-10 rounded-xl bg-white px-4 text-[15px] font-semibold text-zinc-950 transition hover:brightness-110">
              Start building
            </button>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-label="Menu"
              className="-me-1.5 flex h-10 w-10 items-center justify-center rounded-xl text-zinc-200 transition hover:bg-white/[0.05] hover:text-white"
            >
              <Icon d={menuOpen ? "M6 6l12 12 M18 6L6 18" : "M4 9h16 M4 15h16"} />
            </button>
            {menuOpen && (
              <div className="absolute end-0 top-full mt-2 w-56 rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10" onClick={() => setMenuOpen(false)}>
                {[
                  ["#features", "Features"],
                  ...(inApp ? [] : [["#pricing", "Pricing"]]),
                  ["#showcase", "Showcase"],
                  ["#faq", "FAQ"],
                ].map(([href, label]) => (
                  <a key={href} href={href} className="block rounded-xl px-3 py-2 text-[15px] text-zinc-200 hover:bg-white/[0.06]">
                    {label}
                  </a>
                ))}
                <InstallApp className="flex w-full items-center gap-1.5 rounded-xl px-3 py-2 text-[15px] text-zinc-200 hover:bg-white/[0.06]" />
                <div className="my-1 border-t border-white/8" />
                <button onClick={() => onStart("login")} className="block w-full rounded-xl px-3 py-2 text-start text-[15px] font-medium text-white hover:bg-white/[0.06]">
                  Sign in
                </button>
              </div>
            )}
          </div>
        </nav>
      </header>

      <section className="relative">
        <div className="relative mx-auto max-w-[1400px] px-4 pb-10 pt-10 text-center sm:px-6 sm:pb-16 sm:pt-20">
          {/* Flash's mark in its glass orb: one on each side of the tagline on a wide screen, one small one above it on a phone. */}
          <Orb className="mx-auto mb-6 w-20 sm:mb-8 sm:w-28 lg:hidden" id="flash-orb-landing" />
          <div className="pointer-events-none absolute start-[2%] top-[14%] hidden w-[clamp(120px,11vw,190px)] lg:block">
            <Orb className="orb-drift" id="flash-orb-landing-start" />
          </div>
          <div className="pointer-events-none absolute end-[2%] top-[22%] hidden w-[clamp(120px,11vw,190px)] lg:block">
            <Orb className="orb-drift orb-late" id="flash-orb-landing-end" />
          </div>
          {/* The tagline, big and bold, as wide as the page allows. */}
          <h1 className="text-[clamp(42px,7.6vw,104px)] font-bold leading-[0.98] tracking-[-0.045em] text-white">
            <span className="block">{t("One Workspace.")}</span>
            <span className="block text-iris">{t("Infinite Possibilities.")}</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-[16px] leading-relaxed text-zinc-300 sm:text-[19px]">
            Build and publish apps, make slides, write, research, code and translate
            {liveMedia.length ? `, and create ${join(liveMedia)}` : ""}, in your own words. Ask once, and Flash picks the best AI for the job.
          </p>

          {/* The message box: what they type waits while they sign up, then fills Flash's own box. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (idea.trim()) keepIdea({ text: idea.trim(), choice: mode });
              onStart("signup");
            }}
            className="glass-raised mx-auto mt-8 max-w-[740px] rounded-[22px] p-3 text-start sm:mt-10"
          >
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onFocus={() => setBoxFocused(true)}
              onBlur={() => setBoxFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              maxLength={4000}
              placeholder={typed || "I want to build a website for my…"}
              aria-label="Describe what you want to make"
              className="block min-h-[76px] w-full resize-none bg-transparent px-2 pb-2 pt-1.5 text-[16px] text-zinc-100 outline-none placeholder:text-zinc-400 light:placeholder:text-zinc-500"
            />
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => onStart("signup")} aria-label="Add files" className="flex h-10 w-10 items-center justify-center rounded-xl text-zinc-200 transition hover:bg-white/[0.06]">
                <Icon d={ICONS.plus} className="h-5 w-5" />
              </button>
              <label className="relative ms-auto inline-flex h-10 items-center gap-1 rounded-xl px-2.5 text-[15px] font-medium text-zinc-100 hover:bg-white/[0.06]">
                <span>{{ app: "Build", auto: "Chat", image: "Picture", video: "Video", search: "Research" }[mode]}</span>
                <Icon d={ICONS.down} className="h-4 w-4 text-zinc-400" />
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="What to make" className="absolute inset-0 cursor-pointer opacity-0">
                  <option value="app">Build an app or website</option>
                  <option value="auto">Chat</option>
                  {isLive("image") && <option value="image">Make a picture</option>}
                  {isLive("video") && <option value="video">Make a video</option>}
                  <option value="search">Research</option>
                </select>
              </label>
              <button type="button" onClick={() => onStart("signup")} aria-label="Talk" className="flex h-10 w-10 items-center justify-center rounded-xl text-zinc-200 transition hover:bg-white/[0.06]">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3" />
                </svg>
              </button>
              <button type="submit" aria-label="Send" className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-on-brand transition hover:brightness-110">
                <Icon d="M7 17L17 7 M9 7h8v8" className="h-5 w-5" />
              </button>
            </div>
          </form>

          {/* Each chip starts the sentence in the box. */}
          <div className="mx-auto mt-6 flex max-w-[900px] flex-wrap justify-center gap-2.5">
            {(
              [
                ["App", ICONS.app, "text-violet-300 light:text-violet-600", "app", "I want an app that "],
                ["Website", ICONS.globe, "text-sky-300 light:text-sky-600", "app", "I want a website for my "],
                ["Dashboard", ICONS.chart, "text-teal-300 light:text-teal-600", "app", "I want a dashboard that shows "],
                ["Online store", ICONS.card, "text-rose-300 light:text-rose-600", "app", "I want an online store that sells "],
                ...(isLive("image") ? [["Picture", ICONS.image, "text-amber-300 light:text-amber-600", "image", "A picture of "]] : []),
              ] as [string, string, string, typeof mode, string][]
            ).map(([label, d, hue, m, start]) => (
              <button
                key={label}
                onClick={() => {
                  setMode(m);
                  setIdea(start);
                }}
                className="glass inline-flex h-10 items-center gap-2 rounded-lg px-3.5 text-[15px] text-zinc-100 shadow-none transition hover:text-white hover:brightness-110"
              >
                <Icon d={d} className={`h-4 w-4 ${hue}`} />
                {label}
              </button>
            ))}
          </div>
          <p className="mt-5 text-xs text-zinc-500">
            Free{free ? ` with ${free} credits` : ""} every month. No card needed.
          </p>
        </div>

        {/* What Flash builds, rolling by. */}
        <RollingShowcase className="pb-12 sm:pb-20" />
      </section>

      <StackSection className="pb-16 sm:pb-24" />

      <GrowCards className="pb-16 sm:pb-24" onOpen={() => onStart("signup")} />

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
        <section id="pricing" className="mx-auto max-w-[1300px] scroll-mt-16 px-4 py-16 sm:px-6 sm:py-24">
          {/* Choose your plan: the free plan, then paid plans from the lowest yearly price; every plan opens under them. */}
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-12">
            <div>
              <h2 className="text-[clamp(48px,7vw,104px)] font-bold leading-[0.95] tracking-[-0.045em]">
                <span className="block">Choose</span>
                <span className="block">your plan</span>
              </h2>
              <p className="mt-6 max-w-sm text-[18px] leading-snug text-zinc-300 sm:text-[22px]">Start free today, and grow your plan as your apps grow.</p>
            </div>
            <div className="grid gap-4">
              <div className="grid gap-6 rounded-2xl bg-[#f7f6fb] p-6 text-[#0d1124] sm:grid-cols-2 shadow-sm ring-1 ring-[#0d1124]/8 sm:p-8">
                <div>
                  <div className="text-[22px] font-medium">Start for free</div>
                  <div className="mt-3 flex items-baseline">
                    <span className="text-[clamp(64px,8vw,96px)] font-bold leading-none tracking-[-0.04em]">$0</span>
                    <span className="text-[26px] font-medium">/mo</span>
                  </div>
                  <button onClick={() => onStart("signup")} className="mt-6 h-12 rounded-xl bg-[#0d1124] px-6 text-[16px] font-semibold text-[#ffffff] transition hover:bg-[#222944]">
                    Start building
                  </button>
                </div>
                <div>
                  <div className="text-[16px] font-medium">You get:</div>
                  <ul className="mt-3 space-y-2.5 text-[16px]">
                    {[
                      `${(free ?? 200).toLocaleString("en-US")} credits every month`,
                      "Every live tool: chat, apps, pictures and more",
                      `Up to ${FREE_SITES} published apps`,
                      "A database, sign-in and visitor stats for each app",
                    ].map((line) => (
                      <li key={line} className="flex gap-2.5">
                        <Icon d="M5 12l5 5 9-10" className="mt-1 h-4 w-4 shrink-0 text-[#0f9488]" />
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {pricing && (
                <div className="grid gap-6 rounded-2xl bg-brand p-6 text-on-brand sm:grid-cols-2 sm:p-8">
                  <div>
                    <div className="text-[22px] font-medium">Paid plans from</div>
                    <div className="mt-3 flex items-baseline">
                      <span className="text-[clamp(64px,8vw,96px)] font-bold leading-none tracking-[-0.04em]">{money(cheapest)}</span>
                      <span className="text-[26px] font-medium">/mo</span>
                    </div>
                    <div className="mt-2 text-[15px]">{canBuy ? "*Billed yearly" : "*Billed yearly, coming soon"}</div>
                    <button
                      onClick={() => setAllPlans(!allPlans)}
                      aria-expanded={allPlans}
                      aria-controls="all-plans"
                      className="mt-6 h-12 rounded-xl bg-[#0d1124] px-6 text-[16px] font-semibold text-[#ffffff] transition hover:bg-[#222944] light:bg-[#ffffff] light:text-[#0d1124] light:hover:bg-[#eef0f7]"
                    >
                      {allPlans ? "Hide plans" : "See all plans"}
                    </button>
                  </div>
                  <div>
                    <p className="text-[16px] leading-snug">More credits every month, more apps, and more ways to make them yours.</p>
                    <ul className="mt-3 space-y-2.5 text-[16px]">
                      {[
                        "Up to 2 months of unused credits carry over",
                        `Up to ${Math.max(...Object.values(PLAN_SITES)).toLocaleString("en-US")} published apps`,
                        ...(pricing.domainsEnabled ? ["Your own domain for your apps"] : []),
                        "Hide the Made with Flash badge",
                      ].map((line) => (
                        <li key={line} className="flex gap-2.5">
                          <Icon d="M5 12l5 5 9-10" className="mt-1 h-4 w-4 shrink-0" />
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          </div>
          {allPlans && (
            <div id="all-plans" className="mx-auto mt-14 max-w-5xl">
          <p className="mx-auto max-w-xl text-center text-zinc-400">
            {canBuy
              ? "Start free. Upgrade for more monthly credits, or top up any time. Cancel whenever you like, and up to 2 months of unused credits carry over."
              : "Start free with credits every month. Paid plans and top-ups are coming soon."}
          </p>
          <div className="mt-8 flex justify-center">
            <IntervalToggle value={billing} onChange={setBilling} saving={pricing?.yearlySaving} />
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
            </div>
          )}
        </section>
      )}

      {/* Questions: a short headline on the left, and on the right small cards that open in place, two across on a wide screen. */}
      <section id="faq" className="mx-auto grid max-w-[1300px] scroll-mt-16 gap-8 px-4 pb-16 sm:px-6 sm:pb-24 lg:grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)] lg:gap-12">
        <div>
          <h2 className="text-[clamp(32px,4vw,52px)] font-bold leading-[1.02] tracking-[-0.04em]">
            <span className="block">Questions?</span>
            <span className="block text-iris">Answered.</span>
          </h2>
          <p className="mt-4 max-w-xs text-[15px] leading-relaxed text-zinc-400">
            Still wondering about something?{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-zinc-200 underline decoration-white/30 underline-offset-4 hover:text-white">
              Write to us
            </a>
            .
          </p>
        </div>
        <div className="grid items-start gap-2.5 sm:grid-cols-2">
          {faq(liveMedia, soonMedia, canBuy).map((f) => (
            <details key={f.q} className="glass group rounded-2xl px-4 py-3 shadow-none transition open:bg-white/[0.04]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] font-medium text-zinc-100">
                {f.q}
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-[15px] leading-none text-on-brand transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* At the foot of the page: what people made with Flash, ending on the call to start. */}
      <Showcase onStart={() => onStart("signup")} />

      {/* The foot of the page: Flash in a few words, then every page worth finding, in four columns. */}
      <footer className="border-t border-white/6">
        <div className="mx-auto grid max-w-[1300px] gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,1fr))]">
          <div className="max-w-sm">
            <a href="#" className="flex items-center gap-2">
              <BrandMark size={34} id="flash-footer" />
              <Wordmark />
            </a>
            <p className="mt-5 text-[15px] leading-relaxed text-zinc-300">
              Flash is one workspace for building with AI. Describe what you need, an app, a website, an online store or a dashboard, and Flash builds it, with
              chat, research, pictures and video in the same place.
            </p>
            {/* The company that runs Flash. The name ends in a full stop, so the line has none of its own. */}
            <div className="mt-5 flex flex-col gap-1 text-xs text-zinc-500">
              <span>
                © {new Date().getFullYear()} {LEGAL_NAME}
              </span>
              <span>{t.node("{product} is operated by {company}", { product: <Wordmark />, company: LEGAL_NAME })}</span>
              <span>{t("{brand} is a trademark of {company}", { brand: TRADEMARK, company: LEGAL_NAME })}</span>
            </div>
          </div>
          {footerColumns.map(([heading, links]) => (
            <nav key={heading} aria-label={heading}>
              <h2 className="text-[15px] font-semibold text-white">{heading}</h2>
              <ul className="mt-4 space-y-3 text-[15px] text-zinc-400">
                {links.map(([href, label]) => (
                  <li key={label}>
                    <a href={href} className="hover:text-white">
                      {label}
                    </a>
                  </li>
                ))}
                {heading === "Company" && (
                  <li>
                    <a href="/report" className="hover:text-white">
                      {t("Report content")}
                    </a>
                  </li>
                )}
                {heading === "Resources" && (
                  <li>
                    <InstallApp className="flex items-center gap-1.5 hover:text-white" />
                  </li>
                )}
              </ul>
            </nav>
          ))}
        </div>
      </footer>
    </div>
  );
}
