"use client";

import { useState, type ReactNode } from "react";
import type { FunnelCounts, FunnelRange, FunnelSource, FunnelStats, Money } from "@/lib/server/funnel.ts";
import { formatMoney } from "@/lib/shop";
import { msg } from "@/lib/i18n";
import { percent, share, taggedLink } from "@/lib/traffic";
import { useT, type T } from "@/lib/use-t";

const DAY = 86_400_000;

/** A day (YYYY-MM-DD, in UTC) as a short date in the reader's language. */
export const dayLabel = (day: string, locale: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });

const RANGES: [FunnelRange, string][] = [
  [7, msg("7 days")],
  [30, msg("30 days")],
  [90, msg("90 days")],
];
// Earlier days with a limit note, at most this many by date.
const NOTED_DAYS = 3;
const heading = "text-xs font-medium uppercase tracking-wider text-zinc-500";
const field = "h-10 w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70";

const count = (n: number, t: T) => n.toLocaleString(t.locale);
const money = (list: Money[], t: T) => list.map((m) => formatMoney(m.amount, m.currency, t.locale));
const ordersText = (n: number, list: Money[], t: T) => {
  const amount = money(list, t).join(", ") || formatMoney(0, "usd", t.locale);
  return n === 1 ? t("1 order · {amount}", { amount }) : t("{count} orders · {amount}", { count: count(n, t), amount });
};
/** What goes between two numbers: a middle dot, or a comma where digits are Arabic or Persian, whose zero is a dot too. */
const between = (t: T) => (/[\u0660-\u0669\u06F0-\u06F9]/.test((0).toLocaleString(t.locale)) ? "\u060C " : " · ");
/** "9 of 412", with its rate once there are 100 visitors. */
const ofVisitors = (n: number, visitors: number, t: T) => {
  const rate = share(n, visitors);
  const of = t("{count} of {total}", { count: count(n, t), total: count(visitors, t) });
  return rate === null ? of : `${of}${between(t)}${percent(rate, t.locale)}`;
};
const sourceName = (source: string, t: T) => source || t("Direct (typed, bookmarked or shared in a message)");
const campaignName = (c: { medium: string; campaign: string }) => [c.medium, c.campaign].filter(Boolean).join(" · ");

/**
 * Why some of the funnel's days are incomplete: counting paused at the owner's daily limit today or
 * on earlier days, the apps' own steps past theirs, or one connection bringing many new people.
 */
export function FunnelNotes({ stats, onPlans }: { stats: FunnelStats; onPlans?: () => void }) {
  const t = useT();
  // When the owner's day starts again (midnight UTC), in their own clock.
  const time = new Intl.DateTimeFormat(t.locale, { hour: "numeric", minute: "2-digit" }).format(new Date(Date.parse(`${stats.today}T00:00:00Z`) + DAY));
  const earlier = stats.paused.filter((p) => !(p.day === stats.today && stats.pausedToday !== null));
  const stepsEarlier = stats.stepsPaused.filter((p) => !(p.day === stats.today && stats.stepsPausedToday !== null));
  const more = (n: number) => (n === 1 ? t("…and on 1 other day.") : t("…and on {count} other days.", { count: count(n, t) }));
  const notes: string[] = [];
  if (stats.stepsPausedToday !== null) notes.push(t("Your apps' own steps stopped counting for today at {count} (your plan's daily limit).", { count: count(stats.stepsPausedToday, t) }));
  for (const p of earlier.slice(0, NOTED_DAYS)) {
    notes.push(
      t(
        "On {date}, counting paused at {count} people across your apps (your plan's limit). People who came after that aren't in that day's numbers, and their forms, sign-ups and checkouts show as Not matched.",
        { date: dayLabel(p.day, t.locale), count: count(p.people, t) },
      ),
    );
  }
  if (earlier.length > NOTED_DAYS) notes.push(more(earlier.length - NOTED_DAYS));
  for (const p of stepsEarlier.slice(0, NOTED_DAYS)) {
    notes.push(t("On {date}, your apps' own steps stopped counting at {count} (your plan's daily limit).", { date: dayLabel(p.day, t.locale), count: count(p.steps, t) }));
  }
  if (stepsEarlier.length > NOTED_DAYS) notes.push(more(stepsEarlier.length - NOTED_DAYS));
  if (stats.netCapped !== null) {
    notes.push(
      t(
        "On some of these days, over {count} new people came through one internet connection (a school's or an office's Wi-Fi, for example), so some of them count only as page visits.",
        { count: count(stats.netCapped, t) },
      ),
    );
  }
  if (stats.pausedToday === null && !notes.length) return null;
  return (
    <div role="status" className="space-y-2 text-sm text-gold-soft">
      {stats.pausedToday !== null && (
        <p>
          {t(
            "Counting paused for today at {count} people across your apps (your plan's limit). Your apps keep working and page visits still count. Counting people starts again at {time}.",
            { count: count(stats.pausedToday, t), time },
          )}
          {stats.free && (
            <>
              {" "}
              {t("Paid plans count more people.")}
              {onPlans && (
                <>
                  {" "}
                  <button onClick={onPlans} className="text-primary-soft hover:underline">
                    {t("Upgrade plan")}
                  </button>
                </>
              )}
            </>
          )}
        </p>
      )}
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

/** One step of the funnel: its count, and a bar of it against the visitors. */
function StepRow({ label, n, visitors, detail }: { label: string; n: number; visitors: number; detail?: string }) {
  const t = useT();
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[11rem_4.5rem_minmax(0,1fr)]">
      <span className="min-w-0 text-sm text-zinc-300">{label}</span>
      <span className="text-end text-sm font-medium tabular-nums text-zinc-100">{count(n, t)}</span>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-1">
        <div className="h-2 min-w-[4rem] flex-1 rounded-full bg-white/[0.04]" role="img" aria-label={detail ?? label}>
          <div className="h-2 rounded-full bg-primary/70" style={{ width: visitors ? `max(2px, ${Math.min(100, (n / visitors) * 100)}%)` : "2px" }} />
        </div>
        {detail && <span className="shrink-0 text-xs tabular-nums text-zinc-500">{detail}</span>}
      </div>
    </li>
  );
}

/** A source's numbers, each with its column's own word, for a narrow screen. */
function SourceNumbers({ c, visitors, t }: { c: Omit<FunnelCounts, "visitors">; visitors: number | null; t: T }) {
  const pairs: [string, string][] = [
    ...(visitors === null ? [] : [[t("Visitors"), count(visitors, t)] as [string, string]]),
    [t("Forms"), count(c.form, t)],
    [t("Sign-ups"), count(c.signup, t)],
    [t("Checkouts"), count(c.checkout, t)],
    [t("Orders"), count(c.orders, t)],
    [t("Revenue"), money(c.revenue, t).join(", ") || "—"],
  ];
  return (
    <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {pairs.map(([k, v]) => (
        <div key={k} className="flex gap-1">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="tabular-nums text-zinc-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 shrink-0 transition ${open ? "rotate-90" : "rtl:rotate-180"}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Where visitors came from, with what each source brought: a table on wide screens, cards on narrow ones. */
function SourceTable({ stats }: { stats: FunnelStats }) {
  const t = useT();
  const [opened, setOpened] = useState<string[]>([]);
  const toggle = (source: string) => setOpened((list) => (list.includes(source) ? list.filter((s) => s !== source) : [...list, source]));
  const u = stats.unmatched;
  const hasUnmatched = Boolean(u.form || u.signup || u.checkout || u.orders);
  const rows: { key: string; name: string; c: FunnelCounts; source?: FunnelSource; muted?: boolean }[] = [
    ...stats.sources.map((s) => ({ key: `s:${s.source}`, name: sourceName(s.source, t), c: s, source: s })),
    ...(stats.rest ? [{ key: "rest", name: t("Other sources"), c: stats.rest, muted: true }] : []),
  ];
  const cell = "px-2 py-2 text-end tabular-nums";
  const numbers = (c: Omit<FunnelCounts, "visitors">, visitors: number | null) => (
    <>
      <td className={cell}>{visitors === null ? "—" : count(visitors, t)}</td>
      <td className={cell}>{count(c.form, t)}</td>
      <td className={cell}>{count(c.signup, t)}</td>
      <td className={cell}>{count(c.checkout, t)}</td>
      <td className={cell}>{count(c.orders, t)}</td>
      <td className={cell}>
        {c.revenue.length
          ? money(c.revenue, t).map((m) => (
              <span key={m} className="block">
                {m}
              </span>
            ))
          : "—"}
      </td>
    </>
  );
  const nameCell = (name: string, source?: FunnelSource, muted?: boolean) => {
    const open = source ? opened.includes(source.source) : false;
    return (
      <div className="flex min-w-0 items-center gap-1">
        {source?.campaigns.length ? (
          <button
            onClick={() => toggle(source.source)}
            aria-expanded={open}
            aria-label={name}
            className="-ms-1 rounded p-0.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100"
          >
            <Chevron open={open} />
          </button>
        ) : null}
        <bdi dir="auto" title={name} className={`min-w-0 truncate ${muted ? "text-zinc-400" : "text-zinc-200"}`}>
          {name}
        </bdi>
      </div>
    );
  };
  return (
    <div>
      <h3 className={`mb-2 ${heading}`}>{t("By source")}</h3>
      <div className="hidden rounded-xl border border-white/8 bg-white/[0.02] lg:block">
        <table className="w-full table-fixed text-sm text-zinc-300">
          {/* lang lets long words like Registrierungen break with a hyphen. */}
          <thead lang={t.language}>
            <tr className="border-b border-white/6 text-xs text-zinc-500">
              <th scope="col" className="w-[28%] break-words px-3 py-2 text-start font-normal">
                {t("Came from")}
              </th>
              {[t("Visitors"), t("Forms"), t("Sign-ups"), t("Checkouts"), t("Orders")].map((h) => (
                <th key={h} scope="col" className="w-[11.5%] whitespace-normal break-words hyphens-auto px-2 py-2 text-end align-bottom font-normal">
                  {h}
                </th>
              ))}
              <th scope="col" className="w-[14.5%] whitespace-normal break-words hyphens-auto px-2 py-2 pe-3 text-end align-bottom font-normal">
                {t("Revenue")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {rows.map((r) => (
              <SourceRows key={r.key} r={r} opened={opened} nameCell={nameCell} numbers={numbers} />
            ))}
            {hasUnmatched && (
              <tr className="text-zinc-400">
                <td className="px-3 py-2">{nameCell(t("Not matched to a visit"), undefined, true)}</td>
                {numbers(u, null)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 lg:hidden">
        {rows.map((r) => {
          const open = r.source ? opened.includes(r.source.source) : false;
          return (
            <li key={r.key} className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
              <div className="text-sm">{nameCell(r.name, r.source, r.muted)}</div>
              <SourceNumbers c={r.c} visitors={r.c.visitors} t={t} />
              {open &&
                r.source?.campaigns.map((c) => (
                  <div key={`${c.medium}|${c.campaign}`} className="ms-3 mt-2 border-s border-white/8 ps-3">
                    <bdi dir="auto" className="block truncate text-xs text-zinc-300">
                      {campaignName(c)}
                    </bdi>
                    <SourceNumbers c={c} visitors={c.visitors} t={t} />
                  </div>
                ))}
            </li>
          );
        })}
        {hasUnmatched && (
          <li className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
            <p className="text-sm text-zinc-400">{t("Not matched to a visit")}</p>
            <SourceNumbers c={u} visitors={null} t={t} />
          </li>
        )}
      </ul>
    </div>
  );
}

/** A source's row in the table, then its campaigns' rows when it is opened. */
function SourceRows({
  r,
  opened,
  nameCell,
  numbers,
}: {
  r: { name: string; c: FunnelCounts; source?: FunnelSource; muted?: boolean };
  opened: string[];
  nameCell: (name: string, source?: FunnelSource, muted?: boolean) => ReactNode;
  numbers: (c: Omit<FunnelCounts, "visitors">, visitors: number | null) => ReactNode;
}) {
  const open = r.source ? opened.includes(r.source.source) : false;
  return (
    <>
      <tr className={r.muted ? "text-zinc-400" : ""}>
        <td className="px-3 py-2">{nameCell(r.name, r.source, r.muted)}</td>
        {numbers(r.c, r.c.visitors)}
      </tr>
      {open &&
        r.source?.campaigns.map((c) => (
          <tr key={`${c.medium}|${c.campaign}`} className="text-xs text-zinc-400">
            <td className="py-1.5 pe-3 ps-8">
              <bdi dir="auto" title={campaignName(c)} className="block truncate">
                {campaignName(c)}
              </bdi>
            </td>
            {numbers(c, c.visitors)}
          </tr>
        ))}
    </>
  );
}

/** Makes a link to the app with tags, so visits through it show under that source and campaign. */
export function LinkMaker({ addresses }: { addresses: string[] }) {
  const t = useT();
  const [source, setSource] = useState("");
  const [campaign, setCampaign] = useState("");
  const [address, setAddress] = useState(addresses[0] ?? "");
  const [copied, setCopied] = useState(false);
  // Made the way visits are read (see traffic.ts), so what is copied is what gets counted.
  const link = taggedLink(addresses.includes(address) ? address : (addresses[0] ?? ""), { source, campaign });
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  if (!addresses.length) return null;
  return (
    <details className="group rounded-xl border border-white/8 bg-white/[0.02]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-zinc-200 hover:text-white [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition rtl:rotate-180 group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t("Make a link that shows where visitors came from")}
      </summary>
      <div className="space-y-3 border-t border-white/6 p-4">
        <div className={`grid grid-cols-1 gap-3 ${addresses.length > 1 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          <label className="block min-w-0 text-xs text-zinc-500">
            {t("Where you'll share it")}
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="instagram" dir="auto" className={`mt-1 ${field}`} />
          </label>
          <label className="block min-w-0 text-xs text-zinc-500">
            {t("Campaign (optional)")}
            <input value={campaign} onChange={(e) => setCampaign(e.target.value)} dir="auto" className={`mt-1 ${field}`} />
          </label>
          {addresses.length > 1 && (
            <label className="block min-w-0 text-xs text-zinc-500">
              {t("App address")}
              <select value={address} onChange={(e) => setAddress(e.target.value)} dir="ltr" className={`mt-1 ${field} bg-zinc-900`}>
                {addresses.map((a) => (
                  <option key={a} value={a}>
                    {a.replace(/^https:\/\//, "").replace(/\/$/, "")}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p dir="ltr" className="break-all rounded-lg bg-white/[0.03] px-3 py-2 text-start font-mono text-xs text-zinc-300">
          {link}
        </p>
        <button
          onClick={copy}
          className="h-10 w-full rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 sm:w-auto"
        >
          {copied ? t("Copied") : t("Copy link")}
        </button>
      </div>
    </details>
  );
}

/**
 * From visit to sale, for 7, 30 or 90 days: visitors, then each step, counted on its own; where
 * visitors came from and what each source brought; the steps the app reports; and the link maker.
 * stats is null while the range loads (or when it couldn't).
 */
export function FunnelView({ stats, days, onDays, failed }: { stats: FunnelStats | null; days: FunnelRange; onDays: (days: FunnelRange) => void; failed: boolean }) {
  const t = useT();
  const totals = stats?.totals;
  const steps = totals ? totals.form + totals.signup + totals.checkout + totals.orders : 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={heading}>{t("From visit to sale")}</h3>
        <div className="flex rounded-full border border-white/10 p-0.5 text-xs" role="group" aria-label={t("From visit to sale")}>
          {RANGES.map(([d, label]) => (
            <button
              key={d}
              onClick={() => onDays(d)}
              aria-pressed={days === d}
              className={`rounded-full px-3 py-1 ${days === d ? "bg-white/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      {!stats || !totals ? (
        !failed && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
      ) : (
        <>
          {stats.shownDays < stats.days && (
            <p className="-mt-3 text-xs text-zinc-500">
              {stats.shownDays === 1
                ? t("Counting began on {date}, so this shows 1 day.", { date: dayLabel(stats.from, t.locale) })
                : t("Counting began on {date}, so this shows {count} days.", { date: dayLabel(stats.from, t.locale), count: count(stats.shownDays, t) })}
            </p>
          )}
          <div className="space-y-2">
            <ul className="space-y-3 rounded-xl border border-white/8 bg-white/[0.02] p-4">
              <StepRow label={t("Visitors")} n={totals.visitors} visitors={totals.visitors} />
              {totals.form > 0 && <StepRow label={t("Sent a form")} n={totals.form} visitors={totals.visitors} detail={ofVisitors(totals.form, totals.visitors, t)} />}
              {totals.signup > 0 && <StepRow label={t("Signed up")} n={totals.signup} visitors={totals.visitors} detail={ofVisitors(totals.signup, totals.visitors, t)} />}
              {totals.checkout > 0 && (
                <StepRow label={t("Started a checkout")} n={totals.checkout} visitors={totals.visitors} detail={ofVisitors(totals.checkout, totals.visitors, t)} />
              )}
              {totals.orders > 0 && <StepRow label={t("Paid")} n={totals.orders} visitors={totals.visitors} detail={ordersText(totals.orders, totals.revenue, t)} />}
              {!steps && <li className="text-sm text-zinc-500">{t("No forms, sign-ups or orders in these days yet.")}</li>}
            </ul>
            <p className="text-xs text-zinc-500">{t("Each step is counted on its own, not only for people who did the step above it.")}</p>
          </div>
          <SourceTable stats={stats} />
          {stats.appSteps.length > 0 && (
            <div>
              <h3 className={`mb-2 ${heading}`}>{t("Steps your app reports")}</h3>
              <ul className="divide-y divide-white/6 rounded-xl border border-white/8">
                {stats.appSteps.map((s) => {
                  const rate = share(s.people, totals.visitors);
                  return (
                    <li key={s.step} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-sm">
                      <bdi dir="auto" className="min-w-0 truncate font-mono text-xs text-zinc-200">
                        {s.step}
                      </bdi>
                      <span className="tabular-nums text-zinc-400">
                        {s.people === 1 ? t("1 person") : t("{count} people", { count: count(s.people, t) })}
                        {rate !== null && between(t) + t("{share} of visitors", { share: percent(rate, t.locale) })}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-zinc-500">{t("Your app sends these with flashDB.track. Anyone can send them, so use them as a guide.")}</p>
            </div>
          )}
          <LinkMaker addresses={stats.addresses} />
          <div className="space-y-1 text-xs text-zinc-500">
            <p>{t("Forms, sign-ups and checkouts count people matched to their visit the same day or the day before.")}</p>
            <p>{t('"Not matched" counts sends and orders Flash couldn\'t tie to a visit, for example when a phone switched networks.')}</p>
            <p>{t("Paid is every order Stripe confirmed: what buyers paid, before Stripe's and Flash's fees and any refunds.")}</p>
            {totals.visitors < 100 && <p>{t("Rates show once there are 100 visitors.")}</p>}
          </div>
        </>
      )}
    </div>
  );
}
