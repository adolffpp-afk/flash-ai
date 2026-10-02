"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_LABELS, type Engine } from "@/lib/types";
import { api } from "@/lib/store";
import { LogoMark } from "@/app/brand";

type Stats = {
  days: number;
  users: { total: number; new: number; active: number };
  requests: { total: number; failed: number };
  creditsUsed: number;
  creditsOutstanding: number;
  revenueCents: number;
  testRevenueCents: number;
  orders: number;
  costCents: number;
  byEngine: { engine: string; requests: number; credits: number; costCents: number }[];
  byProvider: { provider: string; requests: number; costCents: number }[];
  byModel: { model: string; provider: string; requests: number; costCents: number }[];
  series: { day: number; requests: number; costCents: number }[];
  topUsers: { email: string; requests: number; credits: number; costCents: number }[];
  signups: { email: string; name: string; created_at: number }[];
  subscribers: number;
  testSubscribers: number;
  mrrCents: number;
  planEconomics: {
    name: string;
    priceCents: number;
    credits: number;
    costCents: number;
    feeCents: number;
    profitCents: number;
    subscribers: number | null;
  }[];
};

const RANGES = [7, 30, 90];
const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  fal: "fal.ai",
  groq: "Groq (free)",
  openrouter: "OpenRouter (free)",
  cloudflare: "Cloudflare (free)",
};

const usd = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: number) => v.toLocaleString("en-US");
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-zinc-500">{note}</div>}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            {head.map((h, i) => (
              <th key={h} className={`py-2 font-medium ${i ? "pl-4 text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="py-3 text-zinc-500">
                Nothing yet in this range.
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-zinc-900">
              {r.map((c, j) => (
                <td key={j} className={`py-2 ${j ? "pl-4 text-right tabular-nums text-zinc-300" : "text-zinc-200"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="rounded-xl border border-zinc-800 p-4">
      <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-zinc-500">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Daily AI cost as bars; hovering a day shows its cost and request count. */
function CostChart({ series }: { series: Stats["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => s.costCents));
  const h = hover !== null ? series[hover] : null;
  return (
    <div>
      <div className="h-5 text-xs text-zinc-400">
        {h ? (
          <>
            <span className="text-zinc-200">{day(h.day)}</span> · {usd(h.costCents)} AI cost · {num(h.requests)} requests
          </>
        ) : (
          "Hover a day for details"
        )}
      </div>
      <div className="mt-2 flex h-40 items-end gap-[2px] border-b border-zinc-800" onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => (
          <div
            key={s.day}
            className="flex h-full flex-1 cursor-default items-end"
            onMouseEnter={() => setHover(i)}
            aria-label={`${day(s.day)}: ${usd(s.costCents)}, ${s.requests} requests`}
          >
            <div
              className={`w-full rounded-t-[4px] ${hover === i ? "bg-gold" : "bg-primary"}`}
              style={{ height: s.costCents ? `${Math.max(2, (s.costCents / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
        <span>{series[0] && day(series[0].day)}</span>
        <span>{series.at(-1) && day(series.at(-1)!.day)}</span>
      </div>
    </div>
  );
}

export function AdminDashboard() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api<Stats>(`/api/admin/stats?days=${days}`)
      .then((s) => live && (setStats(s), setError("")))
      .catch((err) => live && setError(err.status === 401 ? "Please sign in first." : err.message));
    return () => {
      live = false;
    };
  }, [days]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-300">
        <p>{error}</p>
        <Link href="/" className="text-sm text-primary-soft hover:underline">
          Back to Flash
        </Link>
      </div>
    );
  }

  const margin = stats ? stats.revenueCents - stats.costCents : 0;
  // Credits are worth one cent each at the Starter price, so this is usage at list price.
  const usageValue = stats ? stats.creditsUsed : 0;
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <LogoMark size={32} />
            Flash dashboard
          </Link>
          <div className="ml-auto flex rounded-lg border border-zinc-800 text-sm" role="radiogroup" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r}
                role="radio"
                aria-checked={days === r}
                onClick={() => setDays(r)}
                className={`px-3 py-1.5 ${days === r ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                {r} days
              </button>
            ))}
          </div>
        </div>

        {!stats ? (
          <p className="mt-10 text-zinc-500">Loading…</p>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Tile
                label="Monthly recurring revenue"
                value={usd(stats.mrrCents)}
                note="Yearly plans counted per month"
              />
              <Tile
                label="Subscribers"
                value={num(stats.subscribers)}
                note={stats.testSubscribers ? `${num(stats.testSubscribers)} test plans` : "Paid-up plans right now"}
              />
              <Tile
                label="Revenue"
                value={usd(stats.revenueCents)}
                note={`${num(stats.orders)} paid orders${stats.testRevenueCents ? ` · ${usd(stats.testRevenueCents)} in test purchases` : ""}`}
              />
              <Tile label="AI provider cost" value={usd(stats.costCents)} note="Estimated from usage and list prices" />
              <Tile
                label="Gross profit"
                value={usd(margin)}
                note={stats.revenueCents ? `${Math.round((margin / stats.revenueCents) * 100)}% of revenue` : "Revenue minus AI cost"}
              />
              <Tile
                label="Credits used"
                value={num(stats.creditsUsed)}
                note={`${usd(usageValue)} at list price · ${stats.costCents ? (usageValue / stats.costCents).toFixed(1) : "–"}× cost`}
              />
              <Tile label="Users" value={num(stats.users.total)} note={`${num(stats.users.new)} new · ${num(stats.users.active)} active`} />
              <Tile
                label="Requests"
                value={num(stats.requests.total)}
                note={`${num(stats.requests.failed)} failed (refunded)`}
              />
              <Tile
                label="Credits outstanding"
                value={num(stats.creditsOutstanding)}
                note="Unspent across all accounts"
              />
              <Tile
                label="AI cost per active user"
                value={stats.users.active ? usd(stats.costCents / stats.users.active) : "–"}
                note={`Over ${stats.days} days`}
              />
            </div>

            <div className="mt-4">
              <Panel title="AI cost per day">
                <CostChart series={stats.series} />
              </Panel>
            </div>

            <div className="mt-4">
              <Panel
                title="Plans and top-ups"
                note="Profit per month if the buyer uses every credit (the worst case), after AI cost and Stripe fees"
              >
                <Table
                  head={["Plan", "Price", "Credits", "Max AI cost", "Fees", "Min profit", "Subs"]}
                  rows={stats.planEconomics.map((r) => [
                    r.name,
                    usd(r.priceCents),
                    num(r.credits),
                    usd(r.costCents),
                    usd(r.feeCents),
                    `${usd(r.profitCents)} (${Math.round((r.profitCents / r.priceCents) * 100)}%)`,
                    r.subscribers === null ? "–" : num(r.subscribers),
                  ])}
                />
              </Panel>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Panel title="By tool" note="Credits charged against what the AI providers cost">
                <Table
                  head={["Tool", "Requests", "Credits", "AI cost", "Markup"]}
                  rows={stats.byEngine.map((r) => [
                    ENGINE_LABELS[r.engine as Engine] ?? r.engine,
                    num(r.requests),
                    num(r.credits),
                    usd(r.costCents),
                    r.costCents ? `${(r.credits / r.costCents).toFixed(1)}×` : "–",
                  ])}
                />
              </Panel>
              <Panel title="By provider" note="What to expect on each provider's bill">
                <Table
                  head={["Provider", "Requests", "AI cost"]}
                  rows={stats.byProvider.map((r) => [PROVIDERS[r.provider] ?? r.provider, num(r.requests), usd(r.costCents)])}
                />
                <div className="mt-4">
                  <Table
                    head={["Model", "Requests", "AI cost"]}
                    rows={stats.byModel.map((r) => [r.model, num(r.requests), usd(r.costCents)])}
                  />
                </div>
              </Panel>
              <Panel title="Top users by AI cost">
                <Table
                  head={["User", "Requests", "Credits", "AI cost"]}
                  rows={stats.topUsers.map((r) => [r.email, num(r.requests), num(r.credits), usd(r.costCents)])}
                />
              </Panel>
              <Panel title="Latest sign-ups">
                <Table
                  head={["User", "Joined"]}
                  rows={stats.signups.map((r) => [r.name ? `${r.name} (${r.email})` : r.email, day(r.created_at)])}
                />
              </Panel>
            </div>
            <p className="mt-6 text-xs text-zinc-500">
              AI costs are estimates from token counts and list prices. Compare them with each provider&apos;s billing
              page now and then. Prices live in src/lib/credits.ts and src/lib/models.ts.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
