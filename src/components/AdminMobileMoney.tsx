"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import type { mobileMoneyReport } from "@/lib/server/pawapay.ts";

/*
 * The dashboard's Mobile money tab: whether pawaPay is live or in its sandbox, the last 30 days'
 * orders and what the paid ones were worth, passes running now, and every order, newest first.
 * A pending order can be checked with pawaPay again (it gives the credits if it's now paid).
 */

type Report = Awaited<ReturnType<typeof mobileMoneyReport>>;

const num = (v: number) => v.toLocaleString("en-US");
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (t: number) =>
  new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

// "pass:pro:year" as "Pro plan, 1 year"; "pack:starter" as "Starter pack".
function productName(id: string): string {
  const [kind, name, interval] = id.split(":");
  const title = (name ?? "").charAt(0).toUpperCase() + (name ?? "").slice(1);
  return kind === "pass" ? `${title} plan, 1 ${interval}` : `${title} pack`;
}

const STATUS: Record<string, string> = {
  completed: "text-emerald-400",
  pending: "text-amber-300",
  failed: "text-zinc-500",
};

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-zinc-600">{note}</div>}
    </div>
  );
}

export function AdminMobileMoney() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState<string | null>(null);

  const load = (before = 0) =>
    api<Report>(`/api/admin/mobile-money${before ? `?before=${before}` : ""}`)
      .then((r) => setReport((old) => (before && old ? { ...r, rows: [...old.rows, ...r.rows] } : r)))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load mobile money."));

  useEffect(() => {
    void load();
  }, []);

  async function check(depositId: string) {
    setChecking(depositId);
    setError("");
    try {
      await api("/api/admin/mobile-money", { method: "POST", json: { depositId } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't check that order.");
    } finally {
      setChecking(null);
    }
  }

  if (!report) return <p className="mt-10 text-zinc-500">{error || "Loading…"}</p>;
  const sum = (status: string, mode: "live" | "sandbox") =>
    report.counts.filter((c) => c.status === status && c.mode === mode).reduce((a, c) => ({ orders: a.orders + c.orders, cents: a.cents + c.usdCents }), { orders: 0, cents: 0 });
  const live = sum("completed", "live");
  const test = sum("completed", "sandbox");
  const pending = sum("pending", "live").orders + sum("pending", "sandbox").orders;
  const failed = sum("failed", "live").orders + sum("failed", "sandbox").orders;

  return (
    <div className="mt-6">
      <p className="text-sm text-zinc-400">
        {report.mode === "live"
          ? "pawaPay is live: everyone in the covered countries can pay with mobile money."
          : report.mode === "sandbox"
            ? "pawaPay sandbox: only admins see mobile money, and nothing is really paid. Add PAWAPAY_LIVE_KEY in Vercel to go live."
            : "Mobile money is off: no pawaPay key is set in Vercel."}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Paid, last 30 days" value={usd(live.cents)} note={`${num(live.orders)} real payments`} />
        <Tile label="Test payments, last 30 days" value={num(test.orders)} note={test.orders ? `${usd(test.cents)} at list price` : "Sandbox"} />
        <Tile label="Passes running now" value={num(report.activePasses)} note="Prepaid, they don't renew" />
        <Tile label="Waiting or failed" value={`${num(pending)} · ${num(failed)}`} note="Last 30 days" />
      </div>
      {error && <p className="mt-3 text-sm text-amber-300">{error}</p>}
      <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 font-normal">When</th>
              <th className="px-3 py-2 font-normal">Who</th>
              <th className="px-3 py-2 font-normal">Bought</th>
              <th className="px-3 py-2 font-normal">Paid</th>
              <th className="px-3 py-2 font-normal">Country</th>
              <th className="px-3 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.deposit_id} className="border-b border-zinc-900 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{when(Number(r.created_at))}</td>
                <td className="px-3 py-2">{r.email ?? "(deleted account)"}</td>
                <td className="px-3 py-2">
                  {productName(r.product)} <span className="text-xs text-zinc-500">{usd(Number(r.usd_cents))}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {num(Number(r.amount))} {r.currency}
                </td>
                <td className="px-3 py-2">{r.country}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className={STATUS[r.status] ?? ""}>{r.status}</span>
                  {r.mode === "sandbox" && <span className="ml-1 text-xs text-amber-400/80">(test)</span>}
                  {r.status === "pending" && (
                    <button
                      onClick={() => check(r.deposit_id)}
                      disabled={checking !== null}
                      className="ml-2 rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {checking === r.deposit_id ? "Checking…" : "Check again"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!report.rows.length && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  No mobile money payments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {report.more && (
        <button onClick={() => load(Number(report.rows.at(-1)!.created_at))} className="mt-3 text-sm text-zinc-400 hover:text-zinc-200">
          Show more
        </button>
      )}
    </div>
  );
}
