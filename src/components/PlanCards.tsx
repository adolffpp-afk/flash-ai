"use client";

import { useState } from "react";
import type { Me, Pricing } from "@/lib/store";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/use-t";

export type Interval = "month" | "year";

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** The free models' daily allowance once the monthly credits are spent, as one line. */
function freeLaneLine(t: Translate, lane: Pricing["freeLane"]): string {
  const blanks = { chats: lane.chats, images: lane.images, transcripts: lane.transcripts ?? 0 };
  if (lane.images && lane.transcripts) return t("Then {chats} free chats, {images} images and {transcripts} transcripts a day on free models", blanks);
  if (lane.images) return t("Then {chats} free chats and {images} images a day on free models", blanks);
  if (lane.transcripts) return t("Then {chats} free chats and {transcripts} transcripts a day on free models", blanks);
  return t("Then {chats} free chats a day on free models", blanks);
}

/** Monthly / yearly switch, like Lovable's and Emergent's pricing pages. */
export function IntervalToggle({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  const t = useT();
  const btn = (v: Interval, label: string) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      className={`h-7 rounded-full px-3 text-sm transition ${value === v ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-100"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-white/8 p-1">
      {btn("month", t("Monthly"))}
      {btn("year", t("Yearly"))}
      <span className="pr-2 text-xs text-gold-soft">{t("save 20%")}</span>
    </div>
  );
}

// The plan highlighted as the popular one.
const POPULAR_PLAN = "pro";

/** Free plus the paid plans, then team plans in a wide row. Pro is highlighted as the popular one. */
export function PlanCards({
  pricing,
  interval,
  current,
  busy,
  onFree,
  onPick,
  comingSoon = false,
  compact = false,
}: {
  pricing: Pricing;
  interval: Interval;
  current?: Me["plan"];
  busy?: string | null;
  onFree?: () => void;
  // extraSeats: people added on top of a team plan's own seats.
  onPick: (plan: string, extraSeats?: number) => void;
  // Paid plans aren't on sale yet: the landing page offers the free plan instead, the app disables them.
  comingSoon?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  // Extra seats picked for each team plan, by plan id.
  const [extra, setExtra] = useState<Record<string, number>>({});
  const pad = compact ? "p-5" : "p-6";
  const button = (p: Pricing["plans"][number]) => {
    const seats = p.seats ? (extra[p.id] ?? 0) : 0;
    const isCurrent = current?.id === p.id && current.interval === interval && (current.extraSeats ?? 0) === seats;
    return (
      <button
        onClick={() => (comingSoon ? onFree?.() : onPick(p.id, seats))}
        disabled={isCurrent || (busy ?? null) !== null || (comingSoon && !onFree)}
        className="mt-auto h-9 rounded-full bg-brand text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-60"
      >
        {isCurrent
          ? t("Current plan")
          : comingSoon
            ? onFree
              ? t("Start free for now")
              : t("Coming soon")
            : busy === p.id
              ? t("Opening…")
              : current
                ? t("Switch to {plan}", { plan: p.name })
                : t("Get {plan}", { plan: p.name })}
      </button>
    );
  };
  const price = (p: Pricing["plans"][number]) => {
    const monthly = interval === "year" ? p.yearlyPriceCents : p.priceCents;
    return (
      <>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-3xl font-medium tracking-tight">{money(monthly)}</span>
          <span className="text-sm text-zinc-500">{t("/ month")}</span>
        </div>
        <div className="text-xs text-zinc-500">
          {interval === "year" ? t("{price} billed yearly", { price: money(monthly * 12) }) : t("billed monthly")}
        </div>
      </>
    );
  };
  const teamPlans = pricing.plans.filter((p) => p.seats);
  const seat = pricing.extraSeat;
  const seatPicker = (p: Pricing["plans"][number]) => {
    if (!seat || comingSoon) return null;
    const n = extra[p.id] ?? 0;
    const set = (v: number) => setExtra((e) => ({ ...e, [p.id]: Math.min(seat.max, Math.max(0, v)) }));
    const step = "h-6 w-6 rounded-full border border-white/10 text-sm text-zinc-200 transition hover:bg-white/[0.04] disabled:opacity-40";
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span>{t("Extra people")}</span>
        <button type="button" className={step} onClick={() => set(n - 1)} disabled={n <= 0} aria-label={t("Fewer people")}>
          −
        </button>
        <span className="w-5 text-center tabular-nums text-zinc-100">{n}</span>
        <button type="button" className={step} onClick={() => set(n + 1)} disabled={n >= seat.max} aria-label={t("More people")}>
          +
        </button>
        <span>
          {t("{price} a month each, with {credits} more credits", {
            price: money(interval === "year" ? seat.yearlyPriceCents : seat.priceCents),
            credits: seat.credits.toLocaleString(t.locale),
          })}
        </span>
      </div>
    );
  };
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div className={`flex flex-col rounded-xl border border-white/8 ${pad}`}>
          <div className="font-medium">{t("Free")}</div>
          <div className="mt-1 text-3xl font-medium tracking-tight">$0</div>
          <div className="text-sm text-zinc-400">{t("{count} credits a month", { count: pricing.freeMonthly })}</div>
          <ul className="mb-4 mt-3 space-y-1 text-xs text-zinc-400">
            <li>✓ {t("Try every live tool")}</li>
            <li>✓ {t("Publish apps")}</li>
            <li>✓ {t("Tops up on the 1st")}</li>
            {pricing.freeLane.chats > 0 && <li>✓ {freeLaneLine(t, pricing.freeLane)}</li>}
          </ul>
          {onFree ? (
            <button onClick={onFree} className="mt-auto h-9 rounded-full border border-white/10 text-sm text-zinc-200 transition hover:bg-white/[0.04]">
              {t("Start free")}
            </button>
          ) : (
            <div className="mt-auto py-2 text-center text-xs text-zinc-500">{current ? "" : t("Your plan")}</div>
          )}
        </div>
        {pricing.plans.filter((p) => !p.seats).map((p) => {
          const popular = p.id === POPULAR_PLAN;
          return (
            <div
              key={p.id}
              className={`flex flex-col rounded-xl border ${pad} ${popular ? "border-holo bg-white/[0.025]" : "border-white/8"}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{p.name}</span>
                {comingSoon ? (
                  <span className="text-[10px] uppercase tracking-wide text-zinc-400">{t("Coming soon")}</span>
                ) : (
                  popular && <span className="text-[10px] font-medium uppercase tracking-wider text-holo">{t("Popular")}</span>
                )}
              </div>
              {price(p)}
              <p className="mt-2 text-xs text-zinc-400">{t(p.blurb)}</p>
              <ul className="mb-4 mt-3 space-y-1 text-xs text-zinc-300">
                {p.features.map((f) => (
                  <li key={f}>✓ {t(f)}</li>
                ))}
              </ul>
              {button(p)}
            </div>
          );
        })}
      </div>
      {teamPlans.map((p) => (
        <div key={p.id} className={`mt-3 flex flex-col gap-4 rounded-xl border border-holo bg-primary-deep/10 sm:flex-row sm:items-center ${pad}`}>
          <div className="sm:w-56 sm:shrink-0">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{p.name}</span>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-soft">{t("For teams")}</span>
              {comingSoon && <span className="text-[10px] uppercase tracking-wide text-zinc-400">{t("Coming soon")}</span>}
            </div>
            {price(p)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-400">{t(p.blurb)}</p>
            <ul className="mt-2 grid gap-1 text-xs text-zinc-300 sm:grid-cols-2">
              {p.features.map((f) => (
                <li key={f}>✓ {t(f)}</li>
              ))}
            </ul>
            {seatPicker(p)}
          </div>
          <div className="grid sm:w-44 sm:shrink-0">{button(p)}</div>
        </div>
      ))}
    </>
  );
}
