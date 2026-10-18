"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ENGINE_LABELS, type Engine } from "@/lib/types";
import { api } from "@/lib/store";
import { LogoMark } from "@/app/brand";
import { AdminReports } from "@/components/AdminReports";
import { AutomationBurnIn, type Health } from "@/components/AutomationBurnIn";
import type { automationStats } from "@/lib/server/automation-admin.ts";
import type { FixedCost, ProfitReport } from "@/lib/server/profit.ts";
import type { ReportedItem } from "@/lib/server/reports.ts";

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
    // Names of the environment variables Flash can't find for this provider (or why one set can't be used).
    missing: string[];
    // It needs no key (SEC EDGAR).
    noKey?: boolean;
    requests: number;
    costCents: number;
  }[];
  // CONNECTOR_KEYS: whether connectors can be used, and what's missing (never the value).
  connectors: {
    setUp: boolean;
    missing: string[];
    newest: string;
    skipped: { version: string; reason: string }[];
    older: { version: string; count: number }[];
    // GitHub in chat: set up once its GitHub App's three variables are set (and CONNECTOR_KEYS).
    github?: { setUp: boolean; missing: string[] };
    // Google Drive in chat: set up once its Cloud project's four variables are set (and CONNECTOR_KEYS).
    google?: { setUp: boolean; missing: string[] };
    // MALLOC_ARENA_MAX as the server started (null: it wasn't set), for the memory PDFs from Drive use.
    pdfArenaMax?: string | null;
  };
  // Virus scanning of uploads (see docs/virus-scan-setup.md): missing variables, and whether the scanner answers.
  virusScan?: { missing: string[]; ready: boolean | null };
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
  // Automations: setup, cron health, runs and money (see automationStats).
  automations?: Awaited<ReturnType<typeof automationStats>>;
};

const RANGES = [7, 30, 90, 365];
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "profit", label: "Net profit" },
  { id: "providers", label: "By provider" },
  { id: "tools", label: "By tool" },
  { id: "users", label: "Users" },
  { id: "automations", label: "Automations" },
  { id: "reports", label: "Reports" },
] as const;
type Tab = (typeof TABS)[number]["id"];
const isTab = (id: unknown): id is Tab => TABS.some((t) => t.id === id);

const usd = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** usd, but a cost above zero that rounds to $0.00 says so. */
const cost = (cents: number) => (cents > 0 && cents < 0.5 ? "under $0.01" : usd(cents));
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

/**
 * Makes a key for CONNECTOR_KEYS in this browser: 32 random bytes from the browser's own random
 * source, shown once to copy into Vercel. It is never sent anywhere; Flash reads it only from its
 * environment, and no page or API ever shows it again.
 */
function ConnectorKeyMaker({ setUp, missing, newest, skipped, older = [] }: Stats["connectors"]) {
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const make = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
    // A first key is the whole value; a new one for a key already set goes beside it as the next version.
    setValue(setUp ? key : JSON.stringify({ v1: key }));
    setCopied(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked: the value is selectable in the box.
    }
  };
  return (
    <div className="space-y-3 text-sm">
      <p>
        {setUp ? (
          <span className="text-emerald-300">
            Set. Users can connect their own accounts in Settings &gt; Connectors. New keys are sealed with {newest}.
          </span>
        ) : (
          <span className="text-zinc-400">
            Not set. Missing {missing.join(", ")}. Until it is, users don&apos;t see connectors at all.
          </span>
        )}
      </p>
      {skipped.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-300">
          {skipped.map((s) => (
            <li key={s.version + s.reason}>
              {s.version} in CONNECTOR_KEYS can&apos;t be read: {s.reason}. Fix it in Vercel and redeploy.
            </li>
          ))}
        </ul>
      )}
      {setUp && older.length > 0 && (
        <ul className="space-y-1 text-xs text-zinc-400">
          {older.map((o) => (
            <li key={o.version}>
              Still sealed with {o.version}: {o.count} {o.count === 1 ? "account or registration" : "accounts and registrations"}. Keep {o.version} in
              CONNECTOR_KEYS until this is gone.
            </li>
          ))}
        </ul>
      )}
      {setUp && (
        <p className="text-xs text-zinc-500">
          Keep CONNECTOR_KEYS as it is: every connected account is sealed with it. To change it, make a new key below and add it
          beside the old one as the next version ({"{"}&quot;v1&quot;:&quot;…&quot;,&quot;v2&quot;:&quot;new key&quot;{"}"}), then
          redeploy. Keep v1 until nothing uses it: it is no longer listed here as still sealed (see docs/connectors-setup.md).
        </p>
      )}
      {!value ? (
        <button
          onClick={make}
          className={
            setUp
              ? "rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/[0.05]"
              : "rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-on-brand hover:brightness-110"
          }
        >
          {setUp ? "Make a new key version" : "Make a connector key"}
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">
            Made in this browser and shown only now. Flash never sees it until you add it to Vercel. Keep a copy in your password
            manager: if it&apos;s lost, everyone has to connect their accounts again.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={value}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="CONNECTOR_KEYS value"
              className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 font-mono text-xs text-zinc-200 outline-none focus:border-primary/70"
            />
            <button onClick={copy} className="h-9 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:brightness-110">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {!setUp && (
        <ol className="list-decimal space-y-1 ps-5 text-xs text-zinc-400">
          <li>Make the key here and copy it.</li>
          <li>Open Vercel, then the flash-ai project, then Settings, then Environment Variables.</li>
          <li>Add CONNECTOR_KEYS with the copied value, marked Sensitive, for Production.</li>
          <li>Redeploy. Connectors appear for everyone once the new deployment is live.</li>
        </ol>
      )}
    </div>
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

const minutes = (m: number) => (m ? `${num(m)} min` : "None");

/**
 * The Automations tab's lines from adminStats: whether they can run here and with which key (names,
 * never values), the cron health lines, and what runs did and cost over the range.
 */
function AutomationLines({ a, days, health }: { a: NonNullable<Stats["automations"]>; days: number; health: Health | null }) {
  // The burn-in card's newer live lines, while it polls; the week's lag and peak spend come with the stats.
  const h = { ...a.health, ...health };
  // Runs by outcome: the last 24 hours beside the last 7 days.
  const outcomes = a.outcomes;
  // What isn't set at all (a CRON_SECRET too short is said apart).
  const absent = a.missing.filter((m) => !(m === "CRON_SECRET" && a.cronSecretShort));
  const writesShare = h.writes.limit ? Math.round((h.writes.writes / h.writes.limit) * 100) : 0;
  return (
    <>
      <Panel title="Setup" note="Only admins can use automations for now, from the burn-in below. Steps are in docs/automations-setup.md.">
        <ul className="space-y-1.5 text-sm">
          <li className={a.server && !a.missing.length ? "text-emerald-300" : "text-zinc-400"}>
            {!a.server
              ? "This deployment doesn't run automations: only production does (or a dev machine with AUTOMATIONS_DEV=1)."
              : a.missing.length
                ? "This deployment can run automations once what's missing below is set."
                : "This deployment runs automations."}
          </li>
          <li className={a.key === "automations" ? "text-emerald-300" : a.key === "shared" ? "text-amber-300" : "text-red-300"}>
            {a.key === "automations"
              ? "AI steps use their own key, ANTHROPIC_AUTOMATIONS_API_KEY (the automations workspace)."
              : a.key === "shared"
                ? `AI steps use chat's key (ANTHROPIC_API_KEY) until ANTHROPIC_AUTOMATIONS_API_KEY is set, with at most ${a.sharedPaid} runs calling the model at once. Automations need their own key before they open to everyone.`
                : "No Anthropic key is set, so AI steps can't run."}
          </li>
          {a.missing.length ? (
            <li className="text-amber-300">
              {absent.length > 0 && (
                <div>
                  Missing {absent.join(", ")}. Add {absent.length === 1 ? "it" : "them"} in Vercel (Production) and redeploy.
                </div>
              )}
              {a.cronSecretShort && <div>CRON_SECRET is set but shorter than 32 characters. Set a longer one in Vercel (Production) and redeploy.</div>}
              {a.missing.includes("CRON_SECRET") && (
                <div className="text-xs text-zinc-500">
                  Until CRON_SECRET is set{a.cronSecretShort ? " to 32 characters or more" : ""}, the tick answers 503 every minute and nothing runs.
                </div>
              )}
            </li>
          ) : (
            <li className="text-emerald-300">CRON_SECRET, the AI key and FLASH_APP_URL are set.</li>
          )}
        </ul>
      </Panel>

      <Panel title="Cron health" note="Worked out from the data, so it costs no writes, and kept up to date with the burn-in below (the week's lag and peak spend each time a run there ends). Paused automations are left out.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Schedules overdue" value={minutes(h.overdueScheduleMin)} note="The oldest automation past its next run" />
          <Tile label="Runs overdue" value={minutes(h.overdueRunMin)} note="The oldest run due that nothing is working on" />
          <Tile label="Start lag (p95)" value={`${num(h.lagP95Sec)} s`} note={`Over ${num(h.lagRuns)} scheduled runs in 7 days`} />
          <Tile label="Queued" value={num(h.queued)} note="Waiting for room to run" />
          <Tile label="AI runs now" value={`${num(h.paidNow)} of ${num(h.maxPaid)}`} note={h.paidOpen ? "Open" : "Paused for a minute after a 429"} />
          <Tile label="429s in the last hour" value={num(h.rateLimitedLastHour)} note="Each pauses AI runs for a minute" />
          <Tile label="Peak spend" value={plural(h.peakCreditsPerMinute, "credit", "credits")} note="The highest minute in 7 days" />
          <Tile
            label="Turso writes this month"
            value={num(h.writes.writes)}
            note={`Estimated from runs by the daily job${h.writes.day ? ` (${h.writes.day})` : ""} · ${writesShare}% of the ${num(h.writes.limit)} a month automations may use`}
          />
          <Tile label="Holds open" value={num(h.openHolds)} note={h.lapsedHolds ? `${num(h.lapsedHolds)} past their lease (the next tick settles them)` : "None past its lease"} />
          <Tile label="Waiting for a newer runner" value={num(h.newerRunner)} note="Runs saved by a newer deployment" />
          {/* Its day (YYYY-MM-DD, UTC) as "Oct 18", which fits a tile on a phone. */}
          <Tile label="Daily job" value={!h.dailyJob ? "Not yet" : Number.isNaN(Date.parse(h.dailyJob)) ? h.dailyJob : day(Date.parse(h.dailyJob))} note="The last day it ran (UTC)" />
        </div>
      </Panel>

      <Panel title={`Runs and money, last ${days} days`} note="Credits charged against what the AI providers cost. A loss is a call that cost Flash money and charged 0 credits.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Tile label="Automations on" value={num(a.active)} note={`${num(a.paused)} paused`} />
          <Tile label="AI requests" value={num(a.requests)} />
          <Tile
            label="Credits charged"
            value={num(a.credits)}
            note={`${usd(a.credits)} at list price · ${cost(a.costCents)} AI cost · ${a.costCents ? `${(a.credits / a.costCents).toFixed(1)}×` : "–"} cost`}
          />
          <Tile label="Losses" value={num(a.losses)} note={a.losses ? `${cost(a.lostCents)} AI cost charged 0 credits` : "None"} />
          <Tile label="Function time" value={`${num(Math.round(a.functionSeconds / 60))} min`} note="Estimated from each step's start and end (waits between tries and pauses left out)" />
        </div>
        <div className="mt-4">
          <Table
            head={["Runs by outcome", "24 hours", "7 days"]}
            rows={[...outcomes]
              .sort((x, y) => y.week - x.week)
              .map((r) => [
                <span key="o">
                  {r.status}
                  {r.outcome && r.outcome !== r.status && <span className="text-zinc-500"> · {r.outcome}</span>}
                </span>,
                num(r.day),
                num(r.week),
              ])}
          />
        </div>
      </Panel>
    </>
  );
}

/** The owner dashboard. initialTab opens a tab by its id (?tab=reports, as report emails link to it). */
export function AdminDashboard({ initialTab }: { initialTab?: string }) {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : "overview");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  // The cron health lines as the burn-in card last loaded them.
  const [health, setHealth] = useState<Health | null>(null);
  // Reports don't depend on the time range, and their count shows on the tab, so they load once.
  const [reports, setReports] = useState<ReportedItem[] | null>(null);
  const [reportsError, setReportsError] = useState("");

  useEffect(() => {
    let live = true;
    api<Stats>(`/api/admin/stats?days=${days}`)
      .then((s) => live && (setStats(s), setError("")))
      .catch((err) => live && setError(err.status === 401 ? "Please sign in first." : err.message));
    return () => {
      live = false;
    };
  }, [days, reload]);

  useEffect(() => {
    let live = true;
    api<{ items: ReportedItem[] }>("/api/admin/reports")
      .then((r) => live && setReports(r.items))
      .catch((err) => live && setReportsError(err.message));
    return () => {
      live = false;
    };
  }, []);
  const openReports = reports?.filter((r) => r.open > 0).length ?? 0;

  // On a phone the tabs scroll sideways: keep the open one in view (?tab=reports opens the last),
  // also once its count shows. Only the tab row scrolls, never the page.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabsRef.current;
    const open = list?.querySelector('[aria-selected="true"]');
    if (!list || !open) return;
    const row = list.getBoundingClientRect();
    const box = open.getBoundingClientRect();
    if (box.right > row.right) list.scrollLeft += box.right - row.right;
    else if (box.left < row.left) list.scrollLeft -= row.left - box.left;
  }, [tab, openReports]);

  // The whole page says so only when there is nothing to show yet; a reload that fails (one the burn-in
  // card asked for when a run ended, say) keeps what is shown, and the burn-in card with it.
  if (error && !stats) {
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
          <div
            className={`ml-auto flex rounded-lg border border-zinc-800 text-sm ${tab === "reports" ? "invisible max-sm:hidden" : ""}`}
            role="radiogroup"
            aria-label="Time range"
          >
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

        <div ref={tabsRef} className="mt-4 flex gap-1 overflow-x-auto border-b border-zinc-800 text-sm" role="tablist" aria-label="Dashboard">
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
              {t.id === "reports" && openReports > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-400/20 px-1.5 text-[11px] font-medium text-amber-300 tabular-nums">{openReports}</span>
              )}
            </button>
          ))}
        </div>

        {error && tab !== "reports" && (
          <p role="status" className="mt-3 flex flex-wrap items-center gap-x-2 text-xs text-red-400">
            Not up to date: {error}
            <button onClick={() => setReload((r) => r + 1)} className="text-zinc-300 underline hover:text-white">
              Try again
            </button>
          </p>
        )}

        {tab === "reports" ? (
          <AdminReports items={reports} error={reportsError} onChange={setReports} />
        ) : !stats ? (
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
              note="Every provider Flash can call, and what to expect on each bill. Uses counts each request a provider worked on, including as a helper (for SearXNG, SEC EDGAR and FRED, the requests Flash sent them). Key names must match exactly in Vercel's Production environment variables, then redeploy."
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
                    r.noKey ? (
                      "None needed"
                    ) : (
                      "Set"
                    )
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
            <Panel title="Connectors" note="Users' own accounts in chat. Their keys and tokens are sealed with CONNECTOR_KEYS.">
              <ConnectorKeyMaker {...stats.connectors} />
              {stats.connectors.github && (
                <div className="mt-4 border-t border-white/6 pt-3 text-sm">
                  <div className="text-zinc-200">GitHub</div>
                  {stats.connectors.github.setUp ? (
                    <div className="text-emerald-300">Set. Users can connect GitHub in Settings &gt; Connectors.</div>
                  ) : (
                    <div className="text-zinc-500">
                      <div>Not set. Until it is, users don&apos;t see GitHub. Steps are in docs/connectors-setup.md.</div>
                      <div className="text-xs break-all">Missing {stats.connectors.github.missing.join(", ")}</div>
                    </div>
                  )}
                </div>
              )}
              {stats.connectors.google && (
                <div className="mt-4 border-t border-white/6 pt-3 text-sm">
                  <div className="text-zinc-200">Google Drive</div>
                  {stats.connectors.google.setUp ? (
                    <div className="text-emerald-300">Set. Users can connect Google Drive in Settings &gt; Connectors.</div>
                  ) : (
                    <div className="text-zinc-500">
                      <div>Not set. Until it is, users don&apos;t see Google Drive. Steps are in docs/connectors-setup.md.</div>
                      <div className="text-xs break-all">Missing {stats.connectors.google.missing.join(", ")}</div>
                    </div>
                  )}
                  {stats.connectors.pdfArenaMax === null ? (
                    <div className="mt-1 text-xs text-amber-300">
                      MALLOC_ARENA_MAX wasn&apos;t set when this server started, so the memory that PDFs from Drive use builds up until
                      it stops reading them for a while. Add it in Vercel with the value 2 and redeploy (docs/connectors-setup.md).
                    </div>
                  ) : (
                    stats.connectors.pdfArenaMax !== undefined && (
                      <div className="mt-1 text-xs text-zinc-500">
                        MALLOC_ARENA_MAX was {stats.connectors.pdfArenaMax} when this server started, which keeps the memory PDFs use small.
                      </div>
                    )
                  )}
                </div>
              )}
            </Panel>
            {stats.virusScan && (
              <Panel title="Virus scanning" note="Checks every file people upload before Flash uses or stores it. Steps are in docs/virus-scan-setup.md.">
                {stats.virusScan.missing.length ? (
                  <div className="text-sm text-zinc-500">
                    <div>Off. Files aren&apos;t scanned until both variables are set.</div>
                    <div className="text-xs break-all">Missing {stats.virusScan.missing.join(", ")}</div>
                  </div>
                ) : stats.virusScan.ready ? (
                  <div className="text-sm text-emerald-300">On. The scanner is answering.</div>
                ) : (
                  <div className="text-sm text-amber-300">
                    Set, but the scanner isn&apos;t answering. Files go through unscanned until it does. Check the scanner on Railway (it takes a few minutes to start).
                  </div>
                )}
              </Panel>
            )}
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
        ) : tab === "automations" ? (
          <div className="mt-6 space-y-4">
            {stats.automations && <AutomationLines a={stats.automations} days={stats.days} health={health} />}
            {/* A run that ends changes the runs and money lines too: they load again. */}
            <AutomationBurnIn onHealth={setHealth} onRunEnded={() => setReload((r) => r + 1)} />
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
        {stats && tab !== "reports" && (
          <p className="mt-6 text-xs text-zinc-500">
            AI costs are estimates from token counts and list prices. Compare them with each provider&apos;s billing
            page now and then. Prices live in src/lib/credits.ts and src/lib/models.ts.
          </p>
        )}
      </div>
    </div>
  );
}
