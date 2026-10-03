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
      className={`rounded-full px-3 py-1.5 text-sm transition ${value === v ? "bg-primary-strong font-medium text-white" : "text-zinc-400 hover:text-zinc-100"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 p-1">
      {btn("month", "Monthly")}
      {btn("year", "Yearly")}
      <span className="pr-2 text-xs text-gold">save 20%</span>
    </div>
  );
}

/** Free plus the paid plans, then team plans in a wide row. The first paid plan is highlighted as the popular one. */
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
  const button = (p: Pricing["plans"][number], popular: boolean) => {
    const isCurrent = current?.id === p.id && current.interval === interval;
    return (
      <button
        onClick={() => (comingSoon ? onFree?.() : onPick(p.id))}
        disabled={isCurrent || (busy ?? null) !== null || (comingSoon && !onFree)}
        className={`mt-auto rounded-lg py-2 text-sm font-medium disabled:opacity-60 ${
          popular
            ? "bg-holo text-zinc-950 hover:brightness-105"
            : "bg-brand text-white hover:brightness-110"
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
    );
  };
  const price = (p: Pricing["plans"][number]) => {
    const monthly = interval === "year" ? p.yearlyPriceCents : p.priceCents;
    return (
      <>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-3xl font-semibold">{money(monthly)}</span>
          <span className="text-sm text-zinc-500">/ month</span>
        </div>
        <div className="text-xs text-zinc-500">
          {interval === "year" ? `${money(monthly * 12)} billed yearly` : "billed monthly"}
        </div>
      </>
    );
  };
  const teamPlans = pricing.plans.filter((p) => p.seats);
  return (
    <>
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
        {pricing.plans.filter((p) => !p.seats).map((p, i) => {
          const popular = i === 0;
          return (
            <div
              key={p.id}
              className={`flex flex-col rounded-xl border ${pad} ${popular ? "border-holo bg-holo-lavender/5 shadow-lg shadow-holo-lavender/10" : "border-zinc-800"}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{p.name}</span>
                {comingSoon ? (
                  <span className="text-[10px] uppercase tracking-wide text-zinc-400">Coming soon</span>
                ) : (
                  popular && <span className="rounded-full bg-holo px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-950">Popular</span>
                )}
              </div>
              {price(p)}
              <p className="mt-2 text-xs text-zinc-400">{p.blurb}</p>
              <ul className="mb-4 mt-3 space-y-1 text-xs text-zinc-300">
                {p.features.map((f) => (
                  <li key={f}>✓ {f}</li>
                ))}
              </ul>
              {button(p, popular)}
            </div>
          );
        })}
      </div>
      {teamPlans.map((p) => (
        <div key={p.id} className={`mt-3 flex flex-col gap-4 rounded-xl border border-holo bg-primary-deep/10 sm:flex-row sm:items-center ${pad}`}>
          <div className="sm:w-56 sm:shrink-0">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{p.name}</span>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-soft">For teams</span>
              {comingSoon && <span className="text-[10px] uppercase tracking-wide text-zinc-400">Coming soon</span>}
            </div>
            {price(p)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-400">{p.blurb}</p>
            <ul className="mt-2 grid gap-1 text-xs text-zinc-300 sm:grid-cols-2">
              {p.features.map((f) => (
                <li key={f}>✓ {f}</li>
              ))}
            </ul>
          </div>
          <div className="grid sm:w-44 sm:shrink-0">{button(p, false)}</div>
        </div>
      ))}
    </>
  );
}
