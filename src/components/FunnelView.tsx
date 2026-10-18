"use client";

import { useState, type ChangeEvent, type ClipboardEvent, type ReactNode } from "react";
import type { FunnelCounts, FunnelRange, FunnelSource, FunnelStats, Money } from "@/lib/server/funnel.ts";
import { formatMoney } from "@/lib/shop";
import { afterSentence, msg } from "@/lib/i18n";
import { PLAN_PEOPLE } from "@/lib/plan-limits";
import { MAX_TAG, cleanTag, passesForLatin, percent, share, shareSource, taggedLink } from "@/lib/traffic";
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
// Sources shown before Show more: the busiest.
const SHOWN_SOURCES = 10;
const heading = "text-xs font-medium uppercase tracking-wider text-zinc-500";
const field = "h-10 w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70";

const count = (n: number, t: T) => n.toLocaleString(t.locale);
const money = (list: Money[], t: T) => list.map((m) => formatMoney(m.amount, m.currency, t.locale));
/** Amounts in several currencies as one list in the reader's language ("30,00 $ und 25,00 €"), never added together. */
const moneyList = (list: Money[], t: T) => new Intl.ListFormat(t.locale, { type: "conjunction" }).format(money(list, t));
const ordersText = (n: number, list: Money[], t: T) => {
  const amount = moneyList(list, t) || formatMoney(0, "usd", t.locale);
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
/** Days as one list in the reader's language ("Oct 12, Oct 8 and Oct 2"). */
const dayList = (days: string[], t: T) => new Intl.ListFormat(t.locale, { type: "conjunction" }).format(days.map((d) => dayLabel(d, t.locale)));
/** Days with the same limit together, newest first, so each limit is said once. */
function byLimit<T extends { day: string }>(list: T[], limit: (x: T) => number): { days: string[]; limit: number }[] {
  const groups: { days: string[]; limit: number }[] = [];
  for (const x of list) {
    const group = groups.find((g) => g.limit === limit(x));
    if (group) group.days.push(x.day);
    else groups.push({ days: [x.day], limit: limit(x) });
  }
  return groups;
}
const campaignName = (c: { medium: string; campaign: string }) => [c.medium, c.campaign].filter(Boolean).join(" · ");
/** Rows added up into one, each currency on its own. */
function sumCounts(list: FunnelCounts[]): FunnelCounts {
  const sum: FunnelCounts = { visitors: 0, form: 0, signup: 0, checkout: 0, orders: 0, revenue: [] };
  for (const c of list) {
    sum.visitors += c.visitors;
    sum.form += c.form;
    sum.signup += c.signup;
    sum.checkout += c.checkout;
    sum.orders += c.orders;
    for (const m of c.revenue) {
      const known = sum.revenue.find((x) => x.currency === m.currency);
      if (known) known.amount += m.amount;
      else sum.revenue.push({ ...m });
    }
  }
  sum.revenue.sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
  return sum;
}

/**
 * Why some of the funnel's days are incomplete: counting paused at the owner's daily limit today or
 * on earlier days, the apps' own steps past theirs, or one connection bringing many new people. A
 * free owner whose counting paused on 2 or more of the last 7 days is offered an upgrade to count
 * more visitors, even on a day it hasn't paused yet.
 */
export function FunnelNotes({ stats, onPlans }: { stats: FunnelStats; onPlans?: () => void }) {
  const t = useT();
  // When the owner's day starts again (midnight UTC), in their own clock: later on their day, or on the next.
  const restart = new Date(Date.parse(`${stats.today}T00:00:00Z`) + DAY);
  const time = new Intl.DateTimeFormat(t.locale, { hour: "numeric", minute: "2-digit" }).format(restart);
  const tomorrow = restart.toDateString() !== new Date().toDateString();
  const earlier = stats.paused.filter((p) => !(p.day === stats.today && stats.pausedToday !== null));
  const stepsEarlier = stats.stepsPaused.filter((p) => !(p.day === stats.today && stats.stepsPausedToday !== null));
  const more = (n: number) => (n === 1 ? t("…and on 1 other day.") : t("…and on {count} other days.", { count: count(n, t) }));
  const notes: string[] = [];
  // App steps start again with people, at midnight UTC.
  const steps =
    stats.stepsPausedToday === null
      ? ""
      : tomorrow
        ? t("Your apps' own steps stopped counting at {count} (your plan's daily limit). They count again tomorrow at {time}.", { count: count(stats.stepsPausedToday, t), time })
        : t("Your apps' own steps stopped counting at {count} (your plan's daily limit). They count again at {time}.", { count: count(stats.stepsPausedToday, t), time });
  // Earlier days in one sentence per limit, so a month of them doesn't fill a phone's screen.
  for (const g of byLimit(earlier.slice(0, NOTED_DAYS), (p) => p.people)) {
    notes.push(
      g.days.length === 1
        ? t(
            "On {date}, counting paused at {count} people across your apps (your plan's limit). People who came after that aren't in that day's numbers, and their forms, sign-ups and checkouts show as Not matched.",
            { date: dayLabel(g.days[0], t.locale), count: count(g.limit, t) },
          )
        : t(
            "On {dates}, counting paused at {count} people across your apps (your plan's limit). People who came after that aren't in those days' numbers, and their forms, sign-ups and checkouts show as Not matched.",
            { dates: dayList(g.days, t), count: count(g.limit, t) },
          ),
    );
  }
  if (earlier.length > NOTED_DAYS) notes.push(more(earlier.length - NOTED_DAYS));
  for (const g of byLimit(stepsEarlier.slice(0, NOTED_DAYS), (p) => p.steps)) {
    notes.push(
      g.days.length === 1
        ? t("On {date}, your apps' own steps stopped counting at {count} (your plan's daily limit).", { date: dayLabel(g.days[0], t.locale), count: count(g.limit, t) })
        : t("On {dates}, your apps' own steps stopped counting at {count} (your plan's daily limit).", { dates: dayList(g.days, t), count: count(g.limit, t) }),
    );
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
  // On the free plan, paused on 2 or more of the last 7 days (see funnelStats).
  const often = stats.pausedWeek;
  if (stats.pausedToday === null && !steps && !notes.length && !often) return null;
  const paused =
    stats.pausedToday === null
      ? ""
      : tomorrow
        ? t(
            "Counting paused at {count} people across your apps (your plan's daily limit). Your apps keep working and page visits still count. Counting people starts again tomorrow at {time}.",
            { count: count(stats.pausedToday, t), time },
          )
        : t(
            "Counting paused at {count} people across your apps (your plan's daily limit). Your apps keep working and page visits still count. Counting people starts again at {time}.",
            { count: count(stats.pausedToday, t), time },
          );
  const numbers = { count: count(PLAN_PEOPLE.lite, t), most: count(PLAN_PEOPLE.agency, t) };
  const morePeople = t("Paid plans count more people: {count} a day on Lite, up to {most} on Agency.", numbers);
  // Counting paused on several days this week, but not (yet) today: said first, with the offer.
  const week =
    often && stats.pausedToday === null
      ? t("Your apps reached the free plan's {count} people a day on {days} of the last 7 days.", { count: count(often.people, t), days: count(often.days, t) })
      : "";
  // A paid plan raises both daily limits: said once, after today's people note, or after the week's,
  // or after the steps note alone. The button names what it brings when counting keeps pausing.
  const upsell = (note: string, offer: string) =>
    stats.free && (
      <>
        {afterSentence(note)}
        {offer}
        {onPlans && (
          <>
            {afterSentence(offer)}
            {/* A label too long for the line (French, Russian...) wraps aligned with the note, not centred. */}
            <button onClick={onPlans} className="text-start text-primary-soft hover:underline">
              {often ? t("Upgrade to count more visitors") : t("Upgrade plan")}
            </button>
          </>
        )}
      </>
    );
  return (
    <div role="status" className="space-y-2 text-sm text-gold-soft">
      {week && (
        <p>
          {week}
          {upsell(week, morePeople)}
        </p>
      )}
      {paused && (
        <p>
          {paused}
          {upsell(paused, morePeople)}
        </p>
      )}
      {steps && (
        <p>
          {steps}
          {!paused && !week && upsell(steps, t("Paid plans count more app steps: {count} a day on Lite, up to {most} on Agency.", numbers))}
        </p>
      )}
      {/* By place: two notes can say the same ("…and on 1 other day."), and the list is made anew each time. */}
      {notes.map((n, i) => (
        <p key={i}>{n}</p>
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
    [t("Revenue"), moneyList(c.revenue, t) || "—"],
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
  const [everySource, setEverySource] = useState(false);
  const toggle = (source: string) => setOpened((list) => (list.includes(source) ? list.filter((s) => s !== source) : [...list, source]));
  const u = stats.unmatched;
  const hasUnmatched = Boolean(u.form || u.signup || u.checkout || u.orders);
  // The busiest 10, then every source by name after Show more. Until then the others are in Other
  // sources, so the rows always add up.
  const shown = everySource ? stats.sources : stats.sources.slice(0, SHOWN_SOURCES);
  const hidden = stats.sources.slice(shown.length);
  const rest = hidden.length ? sumCounts([...hidden, ...(stats.rest ? [stats.rest] : [])]) : stats.rest;
  const rows: { key: string; name: string; c: FunnelCounts; source?: FunnelSource; muted?: boolean }[] = [
    ...shown.map((s) => ({ key: `s:${s.source}`, name: sourceName(s.source, t), c: s, source: s })),
    ...(rest ? [{ key: "rest", name: t("Other sources"), c: rest, muted: true }] : []),
  ];
  const more = hidden.length > 0 && (
    <button onClick={() => setEverySource(true)} className="mx-auto mt-3 block rounded-full border border-white/10 px-4 py-2 text-sm text-zinc-300 transition hover:bg-white/[0.05]">
      {t("Show more")}
    </button>
  );
  // People who came on the day counting by source began, before it began, are in Visitors only.
  const inRows = rows.reduce((n, r) => n + r.c.visitors, 0);
  const before = stats.totals.visitors > inRows;
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
  // A long name wraps, in the table as on a card, so it can be read without hovering (on a tablet too).
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
        <bdi dir="auto" className={`min-w-0 [overflow-wrap:anywhere] ${muted ? "text-zinc-400" : "text-zinc-200"}`}>
          {name}
        </bdi>
      </div>
    );
  };
  const beforeNote = before && (
    <p className="mt-2 text-xs text-zinc-500">{t("People who came on {date} before counting by source began aren't in a source.", { date: dayLabel(stats.from, t.locale) })}</p>
  );
  if (!rows.length && !hasUnmatched) {
    return (
      <div>
        <h3 className={`mb-2 ${heading}`}>{t("By source")}</h3>
        <p className="text-sm text-zinc-500">{t("No visitors counted by source in these days yet.")}</p>
        {beforeNote}
      </div>
    );
  }
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
                    {/* The line in the page's direction, the name in its own. */}
                    <div className="text-xs text-zinc-300 [overflow-wrap:anywhere]">
                      <bdi dir="auto">{campaignName(c)}</bdi>
                    </div>
                    <SourceNumbers c={c} visitors={c.visitors} t={t} />
                  </div>
                ))}
              {open && r.source?.otherCampaigns && (
                <div className="ms-3 mt-2 border-s border-white/8 ps-3">
                  <p className="text-xs text-zinc-400">{t("Other campaigns")}</p>
                  <SourceNumbers c={r.source.otherCampaigns} visitors={r.source.otherCampaigns.visitors} t={t} />
                </div>
              )}
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
      {more}
      {beforeNote}
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
  const t = useT();
  const open = r.source ? opened.includes(r.source.source) : false;
  const others = open ? r.source?.otherCampaigns : null;
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
              <div className="[overflow-wrap:anywhere]">
                <bdi dir="auto">{campaignName(c)}</bdi>
              </div>
            </td>
            {numbers(c, c.visitors)}
          </tr>
        ))}
      {others && (
        <tr className="text-xs text-zinc-400">
          <td className="py-1.5 pe-3 ps-8">
            <span className="block [overflow-wrap:anywhere]">{t("Other campaigns")}</span>
          </td>
          {numbers(others, others.visitors)}
        </tr>
      )}
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
  // A change makes a new link, not yet copied.
  const edit = (set: (value: string) => void) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    set(e.target.value);
    setCopied(false);
  };
  // Made the way visits are read (see traffic.ts), so what is copied is what gets counted.
  const link = taggedLink(addresses.includes(address) ? address : (addresses[0] ?? ""), { source, campaign });
  // What was typed but can't be a tag, which the link leaves out.
  const droppedSource = source.trim() !== "" && !shareSource(source);
  const droppedCampaign = campaign.trim() !== "" && !cleanTag(campaign);
  // Why a name is left out: it could identify someone, or pass for another name.
  const leftOut = (typed: string) => (
    <span className="mt-1 block text-xs text-gold-soft">
      {passesForLatin(typed)
        ? t("Put a space between Latin letters and another alphabet's, like Cyrillic or Greek. Flash leaves out words that mix them, or that only look like Latin letters, as they could pass for another name.")
        : t("Use letters or digits. Flash leaves out names with an @, 7 or more digits or a long code, as they could identify someone.")}
    </span>
  );
  // A web address pasted in is kept whole, past the 40 characters a name may have, so its site's
  // name is read from all of it.
  const pasteSource = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").trim();
    if (text.length <= MAX_TAG || shareSource(text) === cleanTag(text)) return;
    e.preventDefault();
    const box = e.currentTarget;
    const [from, to] = [box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length];
    setSource(box.value.slice(0, from) + text + box.value.slice(to));
    setCopied(false);
  };
  // A campaign is read only with a source, so without one the link leaves it out.
  const noSource = source.trim() === "" && campaign.trim() !== "";
  // Shown with its words as typed, in any script; copied as the browser writes it.
  let shown = link;
  try {
    shown = decodeURI(link);
  } catch {
    // Shown as it is.
  }
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
            <input value={source} onChange={edit(setSource)} onPaste={pasteSource} placeholder="instagram" maxLength={MAX_TAG} dir="auto" className={`mt-1 ${field}`} />
            {droppedSource && leftOut(source)}
            {noSource && <span className="mt-1 block text-xs text-gold-soft">{t("Type where you'll share it too. Without it, the link leaves out the campaign.")}</span>}
          </label>
          <label className="block min-w-0 text-xs text-zinc-500">
            {t("Campaign (optional)")}
            <input value={campaign} onChange={edit(setCampaign)} maxLength={MAX_TAG} dir="auto" className={`mt-1 ${field}`} />
            {droppedCampaign && leftOut(campaign)}
          </label>
          {addresses.length > 1 && (
            <label className="block min-w-0 text-xs text-zinc-500">
              {t("App address")}
              <select value={address} onChange={edit(setAddress)} dir="ltr" className={`mt-1 ${field} bg-zinc-900`}>
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
          {shown}
        </p>
        <button
          onClick={copy}
          // A link without the tags typed would count as Direct, so it isn't copied as if it had them.
          disabled={droppedSource || noSource}
          className="h-10 w-full rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 sm:w-auto"
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
 * stats is null until the first range loads (or when it couldn't); while another range loads, the
 * one before stays, dimmed (loading), so the link maker and opened sources keep what was in them.
 * error is why the last range didn't load, said by its buttons, which then show the range shown.
 */
export function FunnelView({
  stats,
  days,
  onDays,
  error,
  loading = false,
}: {
  stats: FunnelStats | null;
  days: FunnelRange;
  onDays: (days: FunnelRange) => void;
  error: string;
  loading?: boolean;
}) {
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
      {error && (
        <p role="alert" className="-mt-3 text-sm text-red-400">
          {error}
        </p>
      )}
      {!stats || !totals ? (
        !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
      ) : (
        <div aria-busy={loading || undefined} className={`space-y-6 transition-opacity ${loading ? "opacity-50" : ""}`}>
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
        </div>
      )}
    </div>
  );
}
