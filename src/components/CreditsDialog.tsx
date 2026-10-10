"use client";

import { useEffect, useRef, useState } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import { api, type Me } from "@/lib/store";
import { IntervalToggle, PlanCards, type Interval } from "./PlanCards";
import { InviteFriends } from "./InviteFriends";
import { TeamPanel } from "./TeamPanel";
import { ConnectedApps } from "./ConnectedApps";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/use-t";

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
const day = (time: number, locale: string) => new Date(time).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });

/** What still works on free models once credits run out, as one sentence. */
function freeLaneLine(t: Translate, lane: Me["freeLane"]): string {
  const blanks = { chats: lane.chats, images: lane.images, transcripts: lane.transcripts ?? 0 };
  if (lane.images && lane.transcripts)
    return t(
      "Out of credits? Chat, writing, code and translation keep working on free models, {chats} a day, plus {images} free images and {transcripts} free transcripts.",
      blanks,
    );
  if (lane.images) return t("Out of credits? Chat, writing, code and translation keep working on free models, {chats} a day, plus {images} free images.", blanks);
  if (lane.transcripts)
    return t("Out of credits? Chat, writing, code and translation keep working on free models, {chats} a day and {transcripts} free transcripts.", blanks);
  return t("Out of credits? Chat, writing, code and translation keep working on free models, {chats} a day.", blanks);
}

export function CreditsDialog({ me, onClose, onChanged }: { me: Me; onClose: () => void; onChanged: () => void }) {
  const t = useT();
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
        setMessage(t("Test plan started (demo purchases are on). Its credits were added."));
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("Couldn't start checkout."));
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
        setMessage(res.renews ? t("Your test plan will renew again.") : t("Your test plan is cancelled. It runs to the end of the period."));
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("Couldn't open billing."));
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
        setMessage(t("Test credits added (demo purchases are on)."));
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("Couldn't start checkout."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Credits")}
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl border border-white/8 bg-zinc-950 p-6 sm:rounded-2xl sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-zinc-400">{t("Your balance")}</p>
            <p className="text-3xl font-medium tracking-tight">
              {/* The number stays big and gold, the word small, in whichever order the language puts them. */}
              <span className="text-base font-normal text-zinc-400">
                {t.node("{count} credits", {
                  count: <span className="text-gold-gradient text-3xl font-medium">{me.credits.toLocaleString(t.locale)}</span>,
                })}
              </span>
            </p>
            {me.teamCredits !== null && (
              <p className="mt-1 text-xs text-zinc-400">
                {t("{team} from your team's shared pool, {own} your own", {
                  team: me.teamCredits.toLocaleString(t.locale),
                  own: (me.credits - me.teamCredits).toLocaleString(t.locale),
                })}
              </p>
            )}
            {plan ? (
              <p className="mt-1 text-xs text-zinc-400">
                {plan.interval === "year" ? (
                  t.node("{plan}, billed yearly", { plan: <span className="font-medium text-zinc-200">{t("{name} plan", { name: plan.name })}</span> })
                ) : (
                  <span className="font-medium text-zinc-200">{t("{name} plan", { name: plan.name })}</span>
                )}
                {" · "}
                {t("{count} credits a month", { count: plan.credits.toLocaleString(t.locale) })}
                {" · "}
                {plan.nextCredits < plan.paidUntil
                  ? t("next credits {date}", { date: day(plan.nextCredits, t.locale) })
                  : plan.renews
                    ? t("renews {date}", { date: day(plan.paidUntil, t.locale) })
                    : t("ends {date}", { date: day(plan.paidUntil, t.locale) })}
                {plan.test && <span className="ml-1 text-amber-400/80">{t("(test)")}</span>}
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">{t("Free plan tops you back up to {count} credits at the start of each month.", { count: me.freeMonthly })}</p>
            )}
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Plans")}</h3>
          <div className="flex items-center gap-2">
            {plan && (
              <button
                onClick={manage}
                disabled={busy !== null}
                className="h-8 rounded-full border border-white/10 px-3 text-xs text-zinc-200 transition hover:bg-white/[0.04] disabled:opacity-50"
              >
                {busy === "manage" ? t("Opening…") : plan.test ? (plan.renews ? t("Cancel plan") : t("Resume plan")) : t("Manage billing")}
              </button>
            )}
            <IntervalToggle value={billing} onChange={setBilling} />
          </div>
        </div>
        <div className="mt-3">
          <PlanCards pricing={me} interval={billing} current={plan} busy={busy} onPick={subscribe} comingSoon={!canBuy} compact />
        </div>
        {plan && (
          <p className="mt-2 text-xs text-zinc-500">{t("Switching plans starts a new month today at the new price. You keep every credit you already have.")}</p>
        )}

        {me.team && (
          <>
            <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Team")}</h3>
            <div className="mt-2">
              <TeamPanel me={me} onChanged={onChanged} />
            </div>
          </>
        )}

        <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Top up")}</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {me.packs.map((p, i) => (
            <div
              key={p.id}
              className={`flex flex-col rounded-xl border p-5 ${i === 1 ? "border-white/15 bg-white/[0.025]" : "border-white/8"}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{p.name}</span>
                {i === 1 && <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{t("Popular")}</span>}
              </div>
              <div className="mt-1 text-2xl font-medium tracking-tight">{money(p.priceCents)}</div>
              <div className="text-sm text-zinc-400">{t("{count} credits", { count: p.credits.toLocaleString(t.locale) })}</div>
              <p className="mb-3 mt-2 text-xs text-zinc-500">{t(p.blurb)}</p>
              <button
                onClick={() => buy(p.id)}
                disabled={busy !== null || !canBuy}
                className="mt-auto h-9 w-full rounded-full bg-brand text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
              >
                {!canBuy ? t("Coming soon") : busy === p.id ? t("Opening…") : t("Buy")}
              </button>
            </div>
          ))}
        </div>
        {message && <p className="mt-3 text-sm text-amber-300">{message}</p>}
        {!canBuy && !message && (
          <p className="mt-3 text-xs text-zinc-500">{t("Paid plans and top-ups are coming soon. Your free credits refill on the 1st of each month.")}</p>
        )}

        {me.freeLane.chats > 0 && (
          <p className="mt-4 rounded-lg border border-primary/15 bg-primary/[0.05] px-3 py-2 text-xs text-emerald-200">{freeLaneLine(t, me.freeLane)}</p>
        )}

        <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Invite friends")}</h3>
        <div className="mt-2">
          <InviteFriends referral={me.referral} />
        </div>

        <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Connected apps")}</h3>
        <div className="mt-2">
          <ConnectedApps />
        </div>

        <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("What things cost")}</h3>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {ENGINES.map((e) => (
            <div key={e} className="flex justify-between border-b border-white/5 py-1.5">
              <span className="text-zinc-400">{t(ENGINE_LABELS[e])}</span>
              <span>{costLabel(me, e)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {t(
            "Writing, research, code, apps and slides are charged by length (~ is a typical request). A reply stops at what your credits cover, and long conversations cost a little more to read. Failed requests are free.",
          )}
        </p>

        <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Image, video and music models")}</h3>
        <ul className="mt-2 divide-y divide-white/5 text-sm">
          {me.models.map((m) => (
            <li key={m.id} className="flex items-baseline gap-3 py-1.5">
              <span className="w-40 shrink-0 text-zinc-200">{m.label}</span>
              <span className="min-w-0 flex-1 text-xs text-zinc-500">
                {t(m.blurb)}
                {!m.live && <span className="ml-1 text-zinc-400">{t("(coming soon)")}</span>}
              </span>
              <span className="shrink-0">{m.credits}</span>
            </li>
          ))}
        </ul>

        {me.activity.length > 0 && (
          <>
            <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Recent activity")}</h3>
            <ul className="mt-2 divide-y divide-white/5 text-sm">
              {me.activity.map((a, i) => (
                <li key={i} className="flex justify-between py-1.5">
                  <span className="text-zinc-400">
                    {a.reason}
                    <span className="ml-2 text-xs text-zinc-600">{new Date(a.created_at).toLocaleDateString(t.locale)}</span>
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
