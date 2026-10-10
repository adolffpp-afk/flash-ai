"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINE_LABELS, type Engine } from "@/lib/types";
import { api } from "@/lib/store";
import { LogoMark } from "@/app/brand";
import type { FixedCost, ProfitReport } from "@/lib/server/profit.ts";

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
  byProvider: {
    id: string;
    provider: string;
    does: string;
    free: boolean;
    setUp: boolean;
    // Names of the environment variables Flash can't find for this provider.
    missing: string[];
    requests: number;
    costCents: number;
  }[];
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
  profit: ProfitReport;
};

const RANGES = [7, 30, 90, 365];
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "profit", label: "Net profit" },
  { id: "providers", label: "By provider" },
  { id: "tools", label: "By tool" },
  { id: "users", label: "Users" },
] as const;
type Tab = (typeof TABS)[number]["id"];

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

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
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

/** One line of the profit statement: money in is positive, money out negative. */
function Line({ label, cents, note, strong }: { label: string; cents: number; note?: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline gap-4 py-2 ${strong ? "border-t border-zinc-700 font-semibold text-zinc-100" : "text-zinc-300"}`}>
      <div className="min-w-0 flex-1">
        {label}
        {note && <span className="ml-2 text-xs font-normal text-zinc-500">{note}</span>}
      </div>
      <div className={`tabular-nums ${cents < 0 ? "text-zinc-400" : ""}`}>{usd(cents)}</div>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

function ProfitStatement({ p }: { p: ProfitReport }) {
  const sales = p.plansCents + p.packsCents + p.siteFeesCents;
  return (
    <div className="text-sm">
      <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Money in</div>
      <Line label="Plan payments" cents={p.plansCents} note={p.planPayments ? plural(p.planPayments, "payment", "payments") : undefined} />
      <Line label="Credit packs" cents={p.packsCents} note={p.packPayments ? plural(p.packPayments, "payment", "payments") : undefined} />
      <Line label="Fees on site sales" cents={p.siteFeesCents} note={p.siteSales ? plural(p.siteSales, "sale", "sales") : undefined} />
      {p.refundsCents > 0 && <Line label="Refunds" cents={-p.refundsCents} note={plural(p.refunds, "payment", "payments")} />}
      {p.disputesCents > 0 && <Line label="Disputes" cents={-p.disputesCents} note={plural(p.disputes, "payment", "payments")} />}
      <Line label="Kept from sales" cents={p.grossCents} strong />
      <div className="mt-4 text-xs font-medium tracking-wide text-zinc-500 uppercase">Costs</div>
      <Line label="Stripe fees" cents={-p.stripeFeesCents} note="estimated" />
      {p.disputeFeesCents > 0 && <Line label="Stripe dispute fees" cents={-p.disputeFeesCents} note="CA$15 each" />}
      <Line label="AI providers" cents={-p.aiCostCents} note="estimated from usage" />
      <Line
        label="Your bills"
        cents={-p.fixedCents}
        note={p.fixed.length ? `${plural(p.fixed.length, "bill", "bills")}, for ${p.days} days` : "none added yet"}
      />
      <Line
        label="Net profit"
        cents={p.netCents}
        note={sales ? `${Math.round((p.netCents / sales) * 100)}% of sales` : undefined}
        strong
      />
      <ul className="mt-4 space-y-1 text-xs text-zinc-500">
        <li>Before income tax. Test payments aren&apos;t counted. A yearly plan counts in full when it&apos;s paid.</li>
        <li>
          Stripe fees are estimated per payment: 2.9% + 30¢, 0.7% more on plans, 2% to convert US dollars to Canadian
          dollars, and 7¢ for Radar. Stripe keeps its fee when a payment is refunded. Compare with Stripe → Balances now
          and then.
        </li>
        <li>Refunds and disputes count from this update on. A dispute counts as lost.</li>
        {p.otherSiteFees.map((f) => (
          <li key={f.currency}>
            Plus {(f.cents / 100).toFixed(2)} {f.currency} in fees on {plural(f.sales, "site sale", "site sales")} in{" "}
            {f.currency}, not converted to US dollars.
          </li>
        ))}
        <li>
          Credits people hold but haven&apos;t used yet could still cost up to {usd(p.unspentCostCents)} in AI when
          they&apos;re used.
        </li>
      </ul>
    </div>
  );
}

/** The bills Flash pays every month or year, which the owner types in. */
function Bills({ days, costs, onChange }: { days: number; costs: (FixedCost & { rangeCents: number })[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [per, setPer] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async (init: RequestInit & { json?: unknown }, path = "/api/admin/costs") => {
    setBusy(true);
    setError("");
    try {
      await api(path, init);
      onChange();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await send({ method: "POST", json: { name, amount: Number(amount), per } })) {
      setName("");
      setAmount("");
    }
  };
  const field = "rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600";
  return (
    <div className="text-sm">
      <Table
        head={["Bill", "Amount", `Over ${days} days`, ""]}
        rows={costs.map((c) => [
          c.name,
          `${usd(c.amountCents)} per ${c.per}`,
          usd(c.rangeCents),
          <button
            key="remove"
            disabled={busy}
            onClick={() => send({ method: "DELETE" }, `/api/admin/costs?id=${c.id}`)}
            className="text-xs text-zinc-400 hover:text-red-400 disabled:opacity-50"
          >
            Remove
          </button>,
        ])}
      />
      <form onSubmit={add} className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, like Vercel Pro"
          maxLength={60}
          aria-label="Bill name"
          className={`${field} min-w-0 flex-1`}
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="US$"
          inputMode="decimal"
          aria-label="Amount in US dollars"
          className={`${field} w-24`}
        />
        <select value={per} onChange={(e) => setPer(e.target.value === "year" ? "year" : "month")} aria-label="How often" className={field}>
          <option value="month">per month</option>
          <option value="year">per year</option>
        </select>
        <button
          type="submit"
          disabled={busy || !name.trim() || !amount.trim()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <p className="mt-2 text-xs text-zinc-500">
        Add every bill that isn&apos;t paid per use, from each bill or receipt: hosting (Vercel), the database (Turso), the
        domain, email, and so on. AI providers are already counted from usage, so leave them out.
      </p>
    </div>
  );
}

export function AdminDashboard() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    api<Stats>(`/api/admin/stats?days=${days}`)
      .then((s) => live && (setStats(s), setError("")))
      .catch((err) => live && setError(err.status === 401 ? "Please sign in first." : err.message));
    return () => {
      live = false;
    };
  }, [days, reload]);

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

  // Credits are worth one cent each at the Starter price, so this is usage at list price.
  const usageValue = stats ? stats.creditsUsed : 0;
  const net = stats?.profit.netCents ?? 0;
  const sales = stats ? stats.profit.plansCents + stats.profit.packsCents + stats.profit.siteFeesCents : 0;
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

        <div className="mt-4 flex gap-1 overflow-x-auto border-b border-zinc-800 text-sm" role="tablist" aria-label="Dashboard">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 ${
                tab === t.id ? "border-primary text-white" : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {!stats ? (
          <p className="mt-10 text-zinc-500">Loading…</p>
        ) : tab === "overview" ? (
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
                label="Net profit"
                value={usd(net)}
                note={sales ? `${Math.round((net / sales) * 100)}% of sales, after all costs` : "After refunds, fees, AI and bills"}
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
          </>
        ) : tab === "profit" ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Panel title={`Net profit, last ${stats.days} days`} note="Everything Flash took in, minus everything that came off it">
              <ProfitStatement p={stats.profit} />
            </Panel>
            <Panel title="Your bills" note="What you pay every month or year, spread over the days shown">
              <Bills days={stats.days} costs={stats.profit.fixed} onChange={() => setReload((r) => r + 1)} />
            </Panel>
          </div>
        ) : tab === "providers" ? (
          <div className="mt-6 space-y-4">
            <Panel
              title="AI providers"
              note="Every provider Flash can call, and what to expect on each bill. Uses counts each request a provider worked on, including as a helper. Key names must match exactly in Vercel's Production environment variables, then redeploy."
            >
              <Table
                head={["Provider", "Billing", "Key", "Uses", "AI cost"]}
                rows={stats.byProvider.map((r) => [
                  <div key="name">
                    <div>{r.provider}</div>
                    {r.does && <div className="text-xs text-zinc-500">{r.does}</div>}
                  </div>,
                  r.free ? "Free tier" : "Pay per use",
                  r.setUp ? (
                    "Set"
                  ) : (
                    <div key="key" className="text-zinc-500">
                      <div>Not set</div>
                      <div className="text-xs break-all">Missing {r.missing.join(", ")}</div>
                    </div>
                  ),
                  num(r.requests),
                  r.free && !r.costCents ? "Free" : usd(r.costCents),
                ])}
              />
            </Panel>
            <Panel title="Other bills" note="Payments and the bills you added under Net profit">
              <Table
                head={["Provider", `Last ${stats.days} days`]}
                rows={[
                  [
                    <div key="stripe">
                      <div>Stripe</div>
                      <div className="text-xs text-zinc-500">Card fees on plan and credit pack payments, estimated</div>
                    </div>,
                    usd(stats.profit.stripeFeesCents + stats.profit.disputeFeesCents),
                  ],
                  ...stats.profit.fixed.map((c) => [c.name, usd(c.rangeCents)]),
                ]}
              />
            </Panel>
            <Panel title="By model">
              <Table
                head={["Model", "Uses", "AI cost"]}
                rows={stats.byModel.map((r) => [r.model, num(r.requests), usd(r.costCents)])}
              />
            </Panel>
          </div>
        ) : tab === "tools" ? (
          <div className="mt-6">
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
          </div>
        ) : (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
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
        )}
        {stats && (
          <p className="mt-6 text-xs text-zinc-500">
            AI costs are estimates from token counts and list prices. Compare them with each provider&apos;s billing
            page now and then. Prices live in src/lib/credits.ts and src/lib/models.ts.
          </p>
        )}
      </div>
    </div>
  );
}
