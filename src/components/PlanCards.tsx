"use client";

import type { Me, Pricing } from "@/lib/store";

export type Interval = "month" | "year";

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Monthly / yearly switch, like Lovable's and Emergent's pricing pages. */
export function IntervalToggle({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  const btn = (v: Interval, label: string) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      className={`rounded-full px-3 py-1.5 text-sm transition ${value === v ? "bg-white font-medium text-zinc-900" : "text-zinc-400 hover:text-zinc-100"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 p-1">
      {btn("month", "Monthly")}
      {btn("year", "Yearly")}
      <span className="pr-2 text-xs text-emerald-400">save 20%</span>
    </div>
  );
}

/** Free plus the paid plans. The middle paid plan is highlighted as the popular one. */
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
  onPick: (plan: string) => void;
  // Paid plans aren't on sale yet: the landing page offers the free plan instead, the app disables them.
  comingSoon?: boolean;
  compact?: boolean;
}) {
  const pad = compact ? "p-4" : "p-5";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className={`flex flex-col rounded-xl border border-zinc-800 ${pad}`}>
        <div className="font-medium">Free</div>
        <div className="mt-1 text-3xl font-semibold">$0</div>
        <div className="text-sm text-zinc-400">{pricing.freeMonthly} credits a month</div>
        <ul className="mb-4 mt-3 space-y-1 text-xs text-zinc-400">
          <li>✓ Try every live tool</li>
          <li>✓ Publish apps</li>
          <li>✓ Tops up on the 1st</li>
          {pricing.freeLane.chats > 0 && (
            <li>
              ✓ Then {pricing.freeLane.chats} free chats
              {pricing.freeLane.images ? ` and ${pricing.freeLane.images} images` : ""} a day on open-source models
            </li>
          )}
        </ul>
        {onFree ? (
          <button onClick={onFree} className="mt-auto rounded-lg border border-zinc-700 py-2 text-sm hover:bg-zinc-900">
            Start free
          </button>
        ) : (
          <div className="mt-auto py-2 text-center text-xs text-zinc-500">{current ? "" : "Your plan"}</div>
        )}
      </div>
      {pricing.plans.map((p, i) => {
        const monthly = interval === "year" ? p.yearlyPriceCents : p.priceCents;
        const isCurrent = current?.id === p.id && current.interval === interval;
        const popular = i === 0;
        return (
          <div
            key={p.id}
            className={`flex flex-col rounded-xl border ${pad} ${popular ? "border-indigo-500/60 bg-indigo-500/5" : "border-zinc-800"}`}
          >
            <div className="flex items-baseline justify-between">
              <span className="font-medium">{p.name}</span>
              {comingSoon ? (
                <span className="text-[10px] uppercase tracking-wide text-zinc-400">Coming soon</span>
              ) : (
                popular && <span className="text-[10px] uppercase tracking-wide text-indigo-300">Popular</span>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-3xl font-semibold">{money(monthly)}</span>
              <span className="text-sm text-zinc-500">/ month</span>
            </div>
            <div className="text-xs text-zinc-500">
              {interval === "year" ? `${money(monthly * 12)} billed yearly` : "billed monthly"}
            </div>
            <p className="mt-2 text-xs text-zinc-400">{p.blurb}</p>
            <ul className="mb-4 mt-3 space-y-1 text-xs text-zinc-300">
              {p.features.map((f) => (
                <li key={f}>✓ {f}</li>
              ))}
            </ul>
            <button
              onClick={() => (comingSoon ? onFree?.() : onPick(p.id))}
              disabled={isCurrent || (busy ?? null) !== null || (comingSoon && !onFree)}
              className={`mt-auto rounded-lg py-2 text-sm font-medium disabled:opacity-60 ${
                popular
                  ? "bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white hover:brightness-110"
                  : "bg-white text-zinc-900 hover:bg-zinc-200"
              }`}
            >
              {isCurrent
                ? "Current plan"
                : comingSoon
                  ? onFree
                    ? "Start free for now"
                    : "Coming soon"
                  : busy === p.id
                    ? "Opening…"
                    : current
                      ? `Switch to ${p.name}`
                      : `Get ${p.name}`}
            </button>
          </div>
        );
      })}
    </div>
  );
}
