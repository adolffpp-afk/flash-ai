"use client";

import { useState } from "react";
import { ENGINES, ENGINE_LABELS } from "@/lib/types";
import { api, type Me } from "@/lib/store";

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

export function CreditsDialog({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function buy(pack: string) {
    setBusy(pack);
    setMessage("");
    try {
      const res = await api<{ url?: string; demo?: boolean }>("/api/billing/checkout", { method: "POST", json: { pack } });
      if (res.url) window.location.assign(res.url);
      else if (res.demo) {
        setMessage("Test credits added (demo purchases are on).");
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't start checkout.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Credits"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-zinc-800 bg-zinc-950 p-6 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-zinc-400">Your balance</p>
            <p className="text-4xl font-semibold tracking-tight">
              {me.credits.toLocaleString("en-US")} <span className="text-lg font-normal text-zinc-400">credits</span>
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Free plan tops you back up to {me.freeMonthly} credits at the start of each month.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" aria-label="Close">
            ✕
          </button>
        </div>

        <h3 className="mt-6 text-sm font-medium text-zinc-300">Buy credits</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {me.packs.map((p, i) => (
            <div
              key={p.id}
              className={`flex flex-col rounded-xl border p-4 ${i === 1 ? "border-indigo-500/60 bg-indigo-500/5" : "border-zinc-800"}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{p.name}</span>
                {i === 1 && <span className="text-[10px] uppercase tracking-wide text-indigo-300">Popular</span>}
              </div>
              <div className="mt-1 text-2xl font-semibold">{money(p.priceCents)}</div>
              <div className="text-sm text-zinc-400">{p.credits.toLocaleString("en-US")} credits</div>
              <p className="mb-3 mt-2 text-xs text-zinc-500">{p.blurb}</p>
              <button
                onClick={() => buy(p.id)}
                disabled={busy !== null}
                className="mt-auto w-full rounded-lg bg-gradient-to-r from-indigo-600 to-fuchsia-600 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {busy === p.id ? "Opening…" : "Buy"}
              </button>
            </div>
          ))}
        </div>
        {message && <p className="mt-3 text-sm text-amber-300">{message}</p>}
        {!me.paymentsEnabled && !message && (
          <p className="mt-3 text-xs text-zinc-500">Payments switch on once a Stripe key is added.</p>
        )}

        <h3 className="mt-6 text-sm font-medium text-zinc-300">What things cost</h3>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {ENGINES.map((e) => (
            <div key={e} className="flex justify-between border-b border-zinc-900 py-1">
              <span className="text-zinc-400">{ENGINE_LABELS[e]}</span>
              <span>{me.costs[e]}</span>
            </div>
          ))}
        </div>

        {me.activity.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-medium text-zinc-300">Recent activity</h3>
            <ul className="mt-2 divide-y divide-zinc-900 text-sm">
              {me.activity.map((a, i) => (
                <li key={i} className="flex justify-between py-1.5">
                  <span className="text-zinc-400">
                    {a.reason}
                    <span className="ml-2 text-xs text-zinc-600">{new Date(a.created_at).toLocaleDateString()}</span>
                  </span>
                  <span className={a.amount > 0 ? "text-emerald-400" : "text-zinc-300"}>
                    {a.amount > 0 ? "+" : ""}
                    {a.amount}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
