"use client";

import { useEffect, useRef, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Me } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";

/** One price, or a range when an engine's models cost different amounts. */
function costLabel(me: Me, engine: Engine): string {
  if (me.limits[engine]) return `~${me.costs[engine]}`;
  const all = me.models.filter((m) => m.engine === engine);
  const live = all.filter((m) => m.live);
  const prices = (live.length ? live : all).map((m) => m.credits);
  if (!prices.length) return String(me.costs[engine]);
  const [lo, hi] = [Math.min(...prices), Math.max(...prices)];
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function CreditsDialog({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [billing, setBilling] = useState<Interval>(me.plan?.interval ?? "month");
  const plan = me.plan;
  // Plans and top-ups can't be bought until payments are switched on.
  const canBuy = me.paymentsEnabled || me.testPurchases;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Runs once on open: focus starts on Close, and Escape closes the dialog.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function subscribe(planId: string) {
    setBusy(planId);
    setMessage("");
    try {
      const res = await api<{ url?: string; demo?: boolean }>("/api/billing/subscribe", {
        method: "POST",
        json: { plan: planId, interval: billing },
      });
      if (res.url) window.location.assign(res.url);
      else if (res.demo) {
        setMessage("Test plan started (demo purchases are on). Its credits were added.");
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't start checkout.");
    } finally {
      setBusy(null);
    }
  }

  async function manage() {
    setBusy("manage");
    setMessage("");
    try {
      const res = await api<{ url?: string; demo?: boolean; renews?: boolean }>("/api/billing/portal", { method: "POST" });
      if (res.url) window.location.assign(res.url);
      else if (res.demo) {
        setMessage(res.renews ? "Your test plan will renew again." : "Your test plan is cancelled. It runs to the end of the period.");
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Couldn't open billing.");
    } finally {
      setBusy(null);
    }
  }

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
        aria-modal="true"
        aria-label="Credits"
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl border border-zinc-800 bg-zinc-950 p-6 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-zinc-400">Your balance</p>
            <p className="text-4xl font-semibold tracking-tight">
              <span className="text-gold-gradient">{me.credits.toLocaleString("en-US")}</span>{" "}
              <span className="text-lg font-normal text-zinc-400">credits</span>
            </p>
            {plan ? (
              <p className="mt-1 text-xs text-zinc-400">
                <span className="font-medium text-zinc-200">{plan.name} plan</span>
                {plan.interval === "year" ? ", billed yearly" : ""} · {plan.credits.toLocaleString("en-US")} credits a month
                {plan.nextCredits < plan.paidUntil
                  ? ` · next credits ${day(plan.nextCredits)}`
                  : plan.renews
                    ? ` · renews ${day(plan.paidUntil)}`
                    : ` · ends ${day(plan.paidUntil)}`}
                {plan.test && <span className="ml-1 text-amber-400/80">(test)</span>}
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">
                Free plan tops you back up to {me.freeMonthly} credits at the start of each month.
              </p>
            )}
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-zinc-300">Plans</h3>
          <div className="flex items-center gap-2">
            {plan && (
              <button
                onClick={manage}
                disabled={busy !== null}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
              >
                {busy === "manage" ? "Opening…" : plan.test ? (plan.renews ? "Cancel plan" : "Resume plan") : "Manage billing"}
              </button>
            )}
            <IntervalToggle value={billing} onChange={setBilling} />
          </div>
        </div>
        <div className="mt-3">
          <PlanCards pricing={me} interval={billing} current={plan} busy={busy} onPick={subscribe} comingSoon={!canBuy} compact />
        </div>
        {plan && (
          <p className="mt-2 text-xs text-zinc-500">
            Switching plans starts a new month today at the new price. You keep every credit you already have.
          </p>
        )}

        <h3 className="mt-6 text-sm font-medium text-zinc-300">Top up</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {me.packs.map((p, i) => (
            <div
              key={p.id}
              className={`flex flex-col rounded-xl border p-4 ${i === 1 ? "border-gold/60 bg-gold/5 shadow-lg shadow-gold/10" : "border-zinc-800"}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{p.name}</span>
                {i === 1 && <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gold">Popular</span>}
              </div>
              <div className="mt-1 text-2xl font-semibold">{money(p.priceCents)}</div>
              <div className="text-sm text-zinc-400">{p.credits.toLocaleString("en-US")} credits</div>
              <p className="mb-3 mt-2 text-xs text-zinc-500">{p.blurb}</p>
              <button
                onClick={() => buy(p.id)}
                disabled={busy !== null || !canBuy}
                className="mt-auto w-full rounded-lg bg-brand py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {!canBuy ? "Coming soon" : busy === p.id ? "Opening…" : "Buy"}
              </button>
            </div>
          ))}
        </div>
        {message && <p className="mt-3 text-sm text-amber-300">{message}</p>}
        {!canBuy && !message && (
          <p className="mt-3 text-xs text-zinc-500">
            Paid plans and top-ups are coming soon. Your free credits refill on the 1st of each month.
          </p>
        )}

        {me.freeLane.chats > 0 && (
          <p className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            Out of credits? Chat, writing, code and translation keep working on free open-source models,{" "}
            {me.freeLane.chats} a day{me.freeLane.images ? `, plus ${me.freeLane.images} free images` : ""}.
          </p>
        )}

        <h3 className="mt-6 text-sm font-medium text-zinc-300">What things cost</h3>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {ENGINES.map((e) => (
            <div key={e} className="flex justify-between border-b border-zinc-900 py-1">
              <span className="text-zinc-400">{ENGINE_LABELS[e]}</span>
              <span>{costLabel(me, e)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Writing, research, code, apps and slides are charged by length (~ is a typical request). A reply stops at
          what your credits cover, and long conversations cost a little more to read. Failed requests are free.
        </p>

        <h3 className="mt-6 text-sm font-medium text-zinc-300">Image, video and music models</h3>
        <ul className="mt-2 divide-y divide-zinc-900 text-sm">
          {me.models.map((m) => (
            <li key={m.id} className="flex items-baseline gap-3 py-1.5">
              <span className="w-40 shrink-0 text-zinc-200">{m.label}</span>
              <span className="min-w-0 flex-1 text-xs text-zinc-500">
                {m.blurb}
                {!m.live && <span className="ml-1 text-zinc-400">(coming soon)</span>}
              </span>
              <span className="shrink-0">{m.credits}</span>
            </li>
          ))}
        </ul>

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
