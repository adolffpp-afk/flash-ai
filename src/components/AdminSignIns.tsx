"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import type { SignInRow, signInCounts } from "@/lib/server/sign-ins.ts";

/*
 * The dashboard's Sign-ins tab: how many different accounts signed in, used Flash and were made
 * today, this week and this month, a chart of the last 30 days, and the sign-in log (newest first,
 * searchable by email or name). Only the country is kept of where a sign-in came from.
 */

type Counts = Awaited<ReturnType<typeof signInCounts>>;
type Log = { rows: SignInRow[]; more: boolean };

const num = (v: number) => v.toLocaleString("en-US");
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const when = (t: number) =>
  new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

const METHODS: Record<string, string> = {
  password: "Password",
  email_link: "Email link",
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  reset: "Password reset link",
  sign_up: "New account (password)",
};

// A country code as its flag (two regional indicator letters), then the code.
const flag = (code: string) => (code ? `${String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)))} ${code}` : "–");

const SERIES = [
  { id: "signedIn", label: "Signed in" },
  { id: "active", label: "Used Flash" },
  { id: "new", label: "New accounts" },
] as const;
type SeriesId = (typeof SERIES)[number]["id"];

// One figure per period, big, so the counts read at a glance.
function Figures({ label, values, note }: { label: string; values: Counts["active"]; note: string }) {
  const periods = [
    ["Today", values.today],
    ["7 days", values.week],
    ["30 days", values.month],
  ] as const;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {periods.map(([name, value]) => (
          <div key={name}>
            <div className="text-2xl font-semibold tabular-nums">{num(value)}</div>
            <div className="text-[11px] text-zinc-500">{name}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs text-zinc-600">{note}</div>
    </div>
  );
}

function Chart({ series }: { series: Counts["series"] }) {
  const [show, setShow] = useState<SeriesId>("signedIn");
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => s[show]));
  const h = hover !== null ? series[hover] : null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-zinc-800 text-xs" role="radiogroup" aria-label="Chart shows">
          {SERIES.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={show === s.id}
              onClick={() => setShow(s.id)}
              className={`px-2.5 py-1 ${show === s.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-zinc-400">
          {h ? (
            <>
              <span className="text-zinc-200">{day(h.day)}</span> · {num(h.signedIn)} signed in · {num(h.active)} used Flash · {num(h.new)} new
            </>
          ) : (
            "Hover a day for details"
          )}
        </div>
      </div>
      <div className="mt-3 flex h-40 items-end gap-[2px] border-b border-zinc-800" onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => (
          <div
            key={s.day}
            className="flex h-full flex-1 cursor-default items-end"
            onMouseEnter={() => setHover(i)}
            aria-label={`${day(s.day)}: ${s.signedIn} signed in, ${s.active} used Flash, ${s.new} new`}
          >
            <div
              className={`w-full rounded-t-[4px] ${hover === i ? "bg-gold" : "bg-primary"}`}
              style={{ height: s[show] ? `${Math.max(2, (s[show] / max) * 100)}%` : 0 }}
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

export function AdminSignIns() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Searching waits for a short pause in typing.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () => {
        api<{ counts: Counts; log: Log }>(`/api/admin/sign-ins?q=${encodeURIComponent(q)}`)
          .then((r) => live && (setCounts(r.counts), setLog(r.log), setError("")))
          .catch((err) => live && setError(err.message));
      },
      q ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const more = async () => {
    const last = log?.rows.at(-1);
    if (!last) return;
    setBusy(true);
    try {
      const r = await api<{ log: Log }>(`/api/admin/sign-ins?q=${encodeURIComponent(q)}&before=${last.id}`);
      setLog((l) => ({ rows: [...(l?.rows ?? []), ...r.log.rows], more: r.log.more }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !counts) return <p className="mt-10 text-sm text-red-400">{error}</p>;
  if (!counts || !log) return <p className="mt-10 text-zinc-500">Loading…</p>;
  return (
    <>
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-xs text-zinc-400">Total users</div>
        <div className="mt-1 text-4xl font-semibold tabular-nums">{num(counts.users)}</div>
        <div className="mt-1 text-xs text-zinc-500">Every account on Flash</div>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Figures
          label="People who signed in"
          values={counts.signedIn}
          note={counts.since ? `Counted since ${day(counts.since)}` : "Counted from the next sign-in on"}
        />
        <Figures label="New accounts" values={counts.new} note="Sign-ups by any method" />
        <Figures label="People who used Flash" values={counts.active} note="Sent at least one request, signed in or not that day" />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Each person counts once per period, however often they come back. Days are UTC. Someone who stays signed in (up
        to 30 days) shows under Used Flash without signing in again.
      </p>

      <section className="mt-4 rounded-xl border border-zinc-800 p-4">
        <h2 className="text-sm font-medium text-zinc-200">Last 30 days</h2>
        <div className="mt-3">
          <Chart series={counts.series} />
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-zinc-800 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-zinc-200">Sign-in log</h2>
            <p className="mt-0.5 text-xs text-zinc-500">Newest first. Only the country is kept, never the address or device.</p>
          </div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search email or name"
            aria-label="Search the sign-in log"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 sm:w-64"
          />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <th className="py-2 font-medium">When</th>
                <th className="py-2 pl-4 font-medium">Account</th>
                <th className="py-2 pl-4 font-medium">How</th>
                <th className="py-2 pl-4 font-medium">Country</th>
              </tr>
            </thead>
            <tbody>
              {log.rows.map((r) => (
                <tr key={r.id} className="border-b border-zinc-900 last:border-0">
                  <td className="py-2 whitespace-nowrap text-zinc-400 tabular-nums">{when(r.at)}</td>
                  <td className="py-2 pl-4 text-zinc-200">{r.email ? (r.name ? `${r.name} (${r.email})` : r.email) : "Deleted account"}</td>
                  <td className="py-2 pl-4 whitespace-nowrap text-zinc-300">{METHODS[r.method] ?? r.method}</td>
                  <td className="py-2 pl-4 whitespace-nowrap text-zinc-400">{flag(r.country)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!log.rows.length && (
            <p className="py-6 text-center text-sm text-zinc-500">{q ? "No sign-ins match." : "No sign-ins yet. They show here from now on."}</p>
          )}
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        {log.more && (
          <button
            onClick={more}
            disabled={busy}
            className="mt-3 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:text-white disabled:opacity-50"
          >
            {busy ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </>
  );
}
