"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/store";
import { msg } from "@/lib/i18n";
import { useT, type T } from "@/lib/use-t";
import { band, type Band } from "@/lib/seo-band";
import { fixContext, fixableIds, stillToFix, type Check, type CheckId, type SeoContext, type SeoReport } from "@/lib/seo-rules";
import { WHY, labelOf, messageOf } from "@/lib/seo-words";
import type { PageSpeedError, PageSpeedRecord, PageSpeedRun, Rating } from "@/lib/server/pagespeed";

/*
 * An app's search check (SEO) in My websites & apps: its score and what to fix, read from Flash's
 * own copy of the live page (free), and Google's PageSpeed Insights on request (free). Fix it, Fix
 * all and Add it ask the builder for the change in the chat that built the app, after the owner
 * has seen what it costs (see Flash.tsx); nothing runs from here on its own.
 */

/** What GET /api/sites/[slug]/seo answers. checkedAt is the version of the page it's about. */
export type SeoData = {
  checkedAt: number;
  title: string;
  ctx: SeoContext;
  report: SeoReport;
  pagespeed: PageSpeedRecord | null;
  pagespeedStale: boolean;
  pagespeedAvailable: boolean;
  pagespeedRunning: boolean;
  domainTest: string | null;
  // When this page loaded it (not from the server): a result older than a day by then can be asked for again.
  loadedAt: number;
};

/** A change asked for here, for Flash to send in the chat that built the site (at: when it was asked). */
export type SiteFix = { projectId: string; slug: string; title: string; ids: CheckId[]; ctx: SeoContext; at: number };

const BAND_WORDS: Record<Band, string> = { good: msg("Good"), needs: msg("Needs work"), poor: msg("Poor") };
const BAND_TEXT: Record<Band, string> = { good: "text-emerald-400", needs: "text-gold-soft", poor: "text-red-400" };
const HOW = msg(
  "Flash reads your published page's code and checks what Google and visitors need. Important checks, like having a title, count three times as much as small ones; a check that needs only a small change gets half its points. Checks that don't apply to your page don't count. It's Flash's own check of your page's code, it's free, and it isn't your place in Google's results.",
);
const PRICE = msg(
  "It's a normal change to your app, charged like any change you ask for: about {count} credits, depending on its length and your level. Nothing is charged until you press Send to Flash, and failed requests are free.",
);
const WHERE = msg("Flash makes the change in the chat that built this site. Press Update site there to put it live, and this check runs again.");
const RUN_ERRORS: Record<PageSpeedError, string> = {
  quota: msg("Google's speed check isn't available right now. Flash's own check above still works."),
  busy: msg("Google's free speed check is busy right now. Try again later."),
  slow: msg("Google took too long to check your page. Try again later."),
  unreachable: msg("Google couldn't load your page this time. Try again in a few minutes."),
};
const RUNNING = msg("Google is still checking this page. The result shows here when it's done.");
// What each mark in the list says to a screen reader.
const MARKS: Partial<Record<Check["status"], [string, string, string]>> = {
  fail: ["✕", "text-red-400", msg("Problem")],
  warn: ["!", "text-gold-soft", msg("Could be better")],
};
const CATEGORIES = [
  ["performance", msg("Performance")],
  ["accessibility", msg("Accessibility")],
  ["bestPractices", msg("Best practices")],
  ["seo", msg("SEO")],
] as const;
// Google's own lines between good, needs work and poor for its test's numbers.
const LIMITS = { lcp: [2500, 4000], cls: [0.1, 0.25], tbt: [200, 600], fcp: [1800, 3000] } as const;
// A check of the same version at the same address is kept a day (see the pagespeed route).
const KEPT_MS = 24 * 3600_000;
// Polls for a check already running: every 5 seconds, for up to 2 minutes.
const POLL_MS = 5000;
const POLLS = 24;

const dateLabel = (when: number, locale: string) =>
  new Date(when).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plain = (n: number, locale: string, digits = 0) =>
  n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
const sizeLabel = (bytes: number, t: T) =>
  bytes >= 1024 * 1024
    ? t("{size} MB", { size: plain(bytes / 1024 / 1024, t.locale, 1) })
    : t("{size} KB", { size: plain(Math.max(1, Math.round(bytes / 1024)), t.locale) });
// An address as people read it: no https://, no slash at the end.
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const rate = (n: number, [good, poor]: readonly [number, number]): Rating => (n <= good ? "good" : n > poor ? "poor" : "needs");
const isIssue = (c: Check) => c.status === "fail" || c.status === "warn";

function unit(n: number, name: "second" | "millisecond", locale: string) {
  try {
    return new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits: name === "second" ? 1 : 0 }).format(n);
  } catch {
    return `${n} ${name === "second" ? "s" : "ms"}`;
  }
}

// Blanks filled with a piece of the page's code (a tag, an address, a CSS size), shown as code: left
// to right in every language.
const CODE_BLANKS = new Set(["tag", "tags", "url", "links", "value"]);
const CODE_LISTS = new Set<CheckId>(["textSize", "tapTargets", "blocking", "mixed"]);

/** What a check found, in the owner's words, with what came from the page shown as it's written. */
function found(check: Check, t: T): ReactNode {
  const text = messageOf(check);
  if (!text) return null;
  const parts: Record<string, ReactNode> = {};
  for (const [name, value] of Object.entries(check.values)) {
    parts[name] =
      name === "size" && typeof value === "number" ? (
        sizeLabel(value, t)
      ) : typeof value === "number" ? (
        value.toLocaleString(t.locale)
      ) : CODE_BLANKS.has(name) || (name === "list" && CODE_LISTS.has(check.id)) ? (
        <code key={name} dir="ltr" className="rounded bg-white/[0.06] px-1 font-mono text-[0.85em] text-zinc-200 wrap-anywhere">
          {value}
        </code>
      ) : (
        <bdi key={name} dir="auto">
          {value}
        </bdi>
      );
  }
  return t.node(text, parts);
}

/** A score in a ring, in its band's colour. label: what it says to a screen reader, for the ring alone. */
function Ring({ score, size, label }: { score: number; size: 48 | 72; label?: string }) {
  const t = useT();
  const stroke = size === 72 ? 6 : 5;
  const r = (size - stroke) / 2;
  const around = 2 * Math.PI * r;
  return (
    <div
      {...(label ? { role: "img", "aria-label": label } : {})}
      className={`relative shrink-0 ${BAND_TEXT[band(score)]}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-zinc-800" />
        {score > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={around}
            strokeDashoffset={around * (1 - score / 100)}
          />
        )}
      </svg>
      <span
        aria-hidden={label ? true : undefined}
        className={`absolute inset-0 flex items-center justify-center font-semibold tabular-nums ${size === 72 ? "text-xl" : "text-sm"}`}
      >
        {score.toLocaleString(t.locale)}
      </span>
    </div>
  );
}

export function SeoView({
  slug,
  data,
  editCredits,
  onFix,
  onDraft,
  onPreview,
}: {
  slug: string;
  data: SeoData;
  // What a change to an app typically costs (the pricing table's number), said before anything is sent.
  editCredits?: number;
  // Hands the change to Flash; false while Flash is still answering something else.
  onFix?: (fix: SiteFix) => boolean;
  // Puts text in the message box of the chat that built the site, without sending it.
  onDraft?: (draft: { projectId: string; text: string }) => void;
  onPreview: () => void;
}) {
  const t = useT();
  const { report } = data;
  // The change waiting for Send: under the item it's for (key: its id, or "all" for Fix all).
  const [asking, setAsking] = useState<{ key: string; ids: CheckId[]; left: number } | null>(null);
  // The chat that built the site: loading (null), found, or why it can't be.
  const [project, setProject] = useState<{ id?: string; error?: string } | null>(null);
  const [note, setNote] = useState("");
  const [draftError, setDraftError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const canFix = !!onFix && editCredits !== undefined;
  const site = { title: data.title, address: `${data.ctx.appBase}/p/${slug}` };
  const fixable = fixableIds(report);
  const all = fixContext(report, fixable, site);

  useEffect(() => {
    if (asking) panelRef.current?.focus();
  }, [asking]);

  /** The chat that built the site, looked up once. */
  async function projectId(): Promise<string | null> {
    if (project?.id) return project.id;
    try {
      const { project: id } = await api<{ project: string }>(`/api/sites/${slug}/project`);
      setProject({ id });
      return id;
    } catch (err) {
      const error = err instanceof Error ? err.message : t("Couldn't find the chat that built this site.");
      setProject({ error });
      return null;
    }
  }

  function ask(key: string, ids: CheckId[]) {
    const { sent, left } = fixContext(report, ids, site);
    setAsking({ key, ids: sent, left });
    setNote("");
    if (!project?.id) {
      setProject(null);
      void projectId();
    }
  }

  function send() {
    if (!asking || !project?.id || !onFix) return;
    const ok = onFix({ projectId: project.id, slug, title: data.title, ids: asking.ids, ctx: data.ctx, at: Date.now() });
    if (!ok) setNote(t("Flash is still working on a reply. Send this when it's done."));
  }

  async function draft(check: Check) {
    if (!onDraft) return;
    setDraftError("");
    const id = await projectId();
    if (!id) {
      setDraftError(t("Couldn't find the chat that built this site."));
      return;
    }
    const placeholders = String(check.values.list ?? "").split(", ").filter(Boolean);
    onDraft({ projectId: id, text: t("Here are my real details for the site:") + "\n" + placeholders.map((p) => `${p}: `).join("\n") });
  }

  const panel = (key: string) =>
    asking?.key === key && (
      <div
        ref={panelRef}
        tabIndex={-1}
        role="region"
        aria-label={t("Ask Flash to change your app")}
        className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm outline-none"
      >
        <h4 className="font-medium text-zinc-100">{t("Ask Flash to change your app")}</h4>
        <ul className="mt-2 list-disc space-y-0.5 ps-5 text-zinc-300">
          {asking.ids.map((id) => (
            <li key={id}>{labelOf(t, id)}</li>
          ))}
        </ul>
        {asking.left > 0 && (
          <p className="mt-2 text-zinc-400">
            {t("Only the first {count} fit in one change. Press Fix all again after this one for the rest.", { count: asking.ids.length.toLocaleString(t.locale) })}
          </p>
        )}
        <p className="mt-2 text-zinc-400">{t(PRICE, { count: (editCredits ?? 0).toLocaleString(t.locale) })}</p>
        <p className="mt-2 text-zinc-400">{t(WHERE)}</p>
        {project?.error && (
          <p role="alert" className="mt-2 text-red-400">
            {project.error}
          </p>
        )}
        {note && (
          <p role="status" className="mt-2 text-gold-soft">
            {note}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {!project?.error && (
            <button
              onClick={send}
              disabled={!project?.id}
              className="rounded-md bg-brand px-3 py-1.5 font-medium text-on-brand hover:brightness-110 disabled:opacity-50"
            >
              {t("Send to Flash")}
            </button>
          )}
          <button onClick={() => setAsking(null)} className="rounded-md px-3 py-1.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
            {t("Cancel")}
          </button>
        </div>
      </div>
    );

  const button = "shrink-0 ms-auto rounded-md border border-primary/40 px-2.5 py-1 text-xs text-primary-soft hover:bg-primary/10";
  // What an item offers: the builder's change, the owner's own details, or the link preview.
  function action(check: Check): ReactNode {
    if (canFix && stillToFix(report, [check.id]).length) {
      return (
        <button onClick={() => ask(check.id, [check.id])} className={button}>
          {check.status === "tip" ? t("Add it") : t("Fix it")}
        </button>
      );
    }
    if (check.action === "tell" && onDraft) {
      return (
        <button onClick={() => draft(check)} className={button}>
          {t("Write them in the chat")}
        </button>
      );
    }
    if (check.action === "preview") {
      return (
        <button onClick={onPreview} className={button}>
          {t("Link preview")}
        </button>
      );
    }
    return null;
  }

  const toFix = report.checks.filter(isIssue);
  const tips = report.checks.filter((c) => c.status === "tip");
  const flash = report.checks.filter((c) => c.status === "flash");
  const passed = report.checks.filter((c) => c.status === "pass");
  const notCounted = report.checks.filter((c) => c.status === "na");
  const heading = "mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500";
  const summary = "cursor-pointer text-xs font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300";

  // An item to fix or worth knowing: what it is, what was found, and why it matters.
  const item = (check: Check) => {
    const why = WHY[check.id];
    const mark = MARKS[check.status] ?? ["💡", "", ""];
    return (
      <li key={check.id} className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <span aria-hidden className={`w-4 shrink-0 text-center font-semibold ${mark[1]}`}>
            {mark[0]}
          </span>
          <div className="min-w-0 flex-[1_1_12rem]">
            <p className="font-medium text-zinc-100">
              {mark[2] && <span className="sr-only">{t(mark[2])} </span>}
              {labelOf(t, check.id)}
            </p>
            {messageOf(check) && <p className="mt-0.5 break-words text-zinc-300">{found(check, t)}</p>}
            {why && <p className="mt-1 text-xs text-zinc-500">{t(why)}</p>}
            {check.action === "tell" && draftError && (
              <p role="alert" className="mt-1 text-xs text-red-400">
                {draftError}
              </p>
            )}
          </div>
          {action(check)}
        </div>
        {panel(check.id)}
      </li>
    );
  };

  // A short line in a list that's folded away: what Flash does, what passed, what doesn't count.
  const line = (check: Check, mark: string, color: string, word?: string) => (
    <li key={check.id} className="flex gap-2">
      <span aria-hidden className={`w-4 shrink-0 text-center ${color}`}>
        {mark}
      </span>
      <p className="min-w-0 break-words">
        {word && <span className="sr-only">{word} </span>}
        <span className="text-zinc-200">{labelOf(t, check.id)}</span>
        {messageOf(check) && (
          <>
            {" "}
            <span className="text-zinc-600">·</span> <span className="text-zinc-400">{found(check, t)}</span>
          </>
        )}
      </p>
    </li>
  );

  const score = report.score;
  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
        {score === null ? (
          <p className="text-sm text-zinc-300">{t("Couldn't check this page. Update it again to try once more.")}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <Ring score={score} size={72} label={t("Search check: {score} out of 100", { score: score.toLocaleString(t.locale) })} />
            <div className="min-w-0 flex-[1_1_12rem] space-y-1">
              <p className="text-sm">
                <span className={`font-medium ${BAND_TEXT[band(score)]}`}>{t(BAND_WORDS[band(score)])}</span> <span className="text-zinc-600">·</span>{" "}
                <span className="text-zinc-300">
                  {t("Checks passed: {passed} of {total}", { passed: report.passed.toLocaleString(t.locale), total: report.total.toLocaleString(t.locale) })}
                </span>
              </p>
              <p className="text-xs text-zinc-500">{t("Checks the live page, published {date}.", { date: dateLabel(data.checkedAt, t.locale) })}</p>
            </div>
            {canFix && fixable.length >= 2 && all.sent.length > 0 && (
              <button
                onClick={() => ask("all", fixable)}
                className="w-full rounded-md bg-brand px-3 py-2 text-sm font-medium text-on-brand hover:brightness-110 sm:ms-auto sm:w-auto"
              >
                {t("Fix all ({count})", { count: all.sent.length.toLocaleString(t.locale) })}
              </button>
            )}
          </div>
        )}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">{t("How the score works")}</summary>
          <p className="mt-2 text-zinc-400">{t(HOW)}</p>
        </details>
        {panel("all")}
      </section>

      {toFix.length > 0 && (
        <section>
          <h3 className={heading}>{t("To fix")}</h3>
          <ul className="space-y-2">{toFix.map(item)}</ul>
        </section>
      )}
      {tips.length > 0 && (
        <section>
          <h3 className={heading}>{t("Good to know")}</h3>
          <ul className="space-y-2">{tips.map(item)}</ul>
        </section>
      )}
      {flash.length > 0 && (
        <details>
          <summary className={summary}>
            {t("Flash takes care of these")} ({flash.length.toLocaleString(t.locale)})
          </summary>
          <ul className="mt-2 space-y-1.5 text-sm">{flash.map((c) => line(c, "⚡", "text-primary-soft"))}</ul>
        </details>
      )}
      {passed.length > 0 && (
        <details>
          <summary className={summary}>
            {t("Passed")} ({passed.length.toLocaleString(t.locale)})
          </summary>
          <ul className="mt-2 space-y-1.5 text-sm">{passed.map((c) => line(c, "✓", "text-emerald-400", t("Passed")))}</ul>
        </details>
      )}
      {notCounted.length > 0 && (
        <details>
          <summary className={summary}>
            {t("Not counted in your score")} ({notCounted.length.toLocaleString(t.locale)})
          </summary>
          <ul className="mt-2 space-y-1.5 text-sm">{notCounted.map((c) => line(c, "–", "text-zinc-500"))}</ul>
        </details>
      )}

      <PageSpeed slug={slug} data={data} />
    </div>
  );
}

/** Google's PageSpeed Insights for the app's live page, on a phone and on a computer, when the owner asks. */
function PageSpeed({ slug, data }: { slug: string; data: SeoData }) {
  const t = useT();
  const [record, setRecord] = useState(data.pagespeed);
  const [stale, setStale] = useState(data.pagespeedStale);
  const [available, setAvailable] = useState(data.pagespeedAvailable);
  const [checking, setChecking] = useState(false);
  // A check that was already running (started before, or elsewhere): its result is looked for.
  const [waiting, setWaiting] = useState(data.pagespeedRunning);
  const [note, setNote] = useState(data.pagespeedRunning ? t(RUNNING) : "");
  const [tab, setTab] = useState<"mobile" | "desktop">("mobile");
  const flashUrl = `${data.ctx.appBase}/p/${slug}`;
  const domainUrl = data.domainTest ? `https://${data.domainTest}/` : "";
  const [address, setAddress] = useState<"flash" | "domain">(domainUrl && record?.url === domainUrl ? "domain" : "flash");
  const target = address === "domain" && domainUrl ? domainUrl : flashUrl;
  // Asking again would bring back the same result: the button shows once the page changes, or a day on.
  const fresh = Boolean(record && !stale && record.url === target && data.loadedAt - record.at < KEPT_MS);

  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const next = await api<SeoData>(`/api/sites/${slug}/seo`);
        if (!next.pagespeedRunning) {
          setWaiting(false);
          setNote("");
          setRecord(next.pagespeed);
          setStale(next.pagespeedStale);
          setAvailable(next.pagespeedAvailable);
          return;
        }
      } catch {
        // Looked for again in 5 seconds.
      }
      if (tries >= POLLS) setWaiting(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, slug]);

  async function check() {
    setChecking(true);
    setNote("");
    try {
      const { pagespeed } = await api<{ pagespeed: PageSpeedRecord }>(`/api/sites/${slug}/pagespeed`, { method: "POST", json: { address } });
      setRecord(pagespeed);
      setStale(false);
    } catch (err) {
      const { code, message } = err as Error & { code?: string };
      if (code === "pagespeed_unavailable" || code === "quota") setAvailable(false);
      else {
        setNote(message);
        if (code === "running") setWaiting(true);
      }
    }
    setChecking(false);
  }

  const run = record?.[tab];
  return (
    <section className="space-y-3 rounded-xl border border-white/8 bg-white/[0.02] p-4" aria-labelledby="pagespeed-heading">
      <h3 id="pagespeed-heading" className="font-medium text-zinc-100">
        PageSpeed Insights
      </h3>
      <p className="text-sm text-zinc-400">{t("Google loads your live page on a phone and on a computer, and scores it. It's free and takes up to a minute.")}</p>
      {!available ? (
        <p className="text-sm text-gold-soft">{t(RUN_ERRORS.quota)}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {domainUrl && (
            <select
              value={address}
              onChange={(e) => setAddress(e.target.value === "domain" ? "domain" : "flash")}
              aria-label={t("Test: {address}", { address: shortUrl(target) })}
              className="min-w-0 max-w-full rounded-md border border-white/10 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
            >
              <option value="flash">{t("Test: {address}", { address: shortUrl(flashUrl) })}</option>
              <option value="domain">{t("Test: {address}", { address: shortUrl(domainUrl) })}</option>
            </select>
          )}
          {!fresh && (
            <button
              onClick={check}
              disabled={checking || waiting}
              className="rounded-md border border-primary/40 px-3 py-1.5 text-sm text-primary-soft hover:bg-primary/10 disabled:opacity-50"
            >
              {t("Check with Google")}
            </button>
          )}
        </div>
      )}
      <p aria-live="polite" className={checking || note ? "text-sm text-zinc-300" : "sr-only"}>
        {checking ? t("Google is checking your page…") : note}
      </p>

      {record && run && (
        <div className="space-y-3">
          {stale && <p className="text-sm text-gold-soft">{t("From before your last update. Check again to see the page as it is now.")}</p>}
          <div className={`space-y-3 ${stale ? "opacity-60" : ""}`}>
            <div className="inline-flex rounded-lg border border-white/10 p-0.5 text-sm">
              {(["mobile", "desktop"] as const).map((s) => (
                <button
                  key={s}
                  aria-pressed={tab === s}
                  onClick={() => setTab(s)}
                  className={`rounded-md px-3 py-1 ${tab === s ? "bg-white/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
                >
                  {s === "mobile" ? t("On a phone") : t("On a computer")}
                </button>
              ))}
            </div>
            <Run run={run} />
            <p className="text-xs text-zinc-500">
              {t.node("Tested {address} on {date}. Google's scores change a little from run to run.", {
                address: <bdi dir="ltr">{shortUrl(record.url)}</bdi>,
                date: dateLabel(record.at, t.locale),
              })}
            </p>
          </div>
        </div>
      )}
      {/* Google's own page for the last result, or to run the check there while Flash can't. */}
      {(record || !available) && (
        <a
          href={`https://pagespeed.web.dev/analysis?url=${encodeURIComponent(record?.url ?? target)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm text-primary-soft hover:underline"
        >
          {t("Open the full report on Google")} ↗
        </a>
      )}
    </section>
  );
}

/** One of Google's checks (a phone's or a computer's): its four scores, real visitors' numbers, and its test's. */
function Run({ run }: { run: PageSpeedRun }) {
  const t = useT();
  if (!run.ok) return <p className="text-sm text-gold-soft">{t(RUN_ERRORS[run.error])}</p>;
  const seconds = (ms: number) => unit(ms / 1000, "second", t.locale);
  const millis = (ms: number) => unit(Math.round(ms), "millisecond", t.locale);
  const shift = (n: number) => n.toLocaleString(t.locale, { maximumFractionDigits: 2 });
  const heading = "text-xs font-medium uppercase tracking-wider text-zinc-500";
  const { field, lab } = run;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CATEGORIES.map(([key, label]) => {
          const score = run.scores[key];
          return (
            <div key={key} className="flex flex-col items-center gap-1.5 text-center">
              {score === null ? (
                <div aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full border-[5px] border-zinc-800 text-zinc-500">
                  –
                </div>
              ) : (
                <Ring score={score} size={48} />
              )}
              <p className="text-xs text-zinc-300">{t(label)}</p>
              {score === null && <p className="text-[11px] text-zinc-500">{t("Not scored")}</p>}
            </div>
          );
        })}
      </div>
      <div className="space-y-1">
        <h4 className={heading}>{t("What real visitors got (Chrome users, last {days} days)", { days: (28).toLocaleString(t.locale) })}</h4>
        {field ? (
          <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
            {field.lcp && <Metric label={msg("Main content shows (LCP)")} value={seconds(field.lcp.p75)} rating={field.lcp.rating} />}
            {field.inp && <Metric label={msg("Reacts to taps (INP)")} value={millis(field.inp.p75)} rating={field.inp.rating} />}
            {field.cls && <Metric label={msg("Layout stays still (CLS)")} value={shift(field.cls.p75)} rating={field.cls.rating} />}
          </dl>
        ) : (
          <p className="text-sm text-zinc-400">{t("Google doesn't have enough visits from Chrome users yet to show what real visitors got.")}</p>
        )}
      </div>
      <div className="space-y-1">
        <h4 className={heading}>{t("In Google's test")}</h4>
        <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
          {lab.lcpMs !== undefined && <Metric label={msg("Main content shows (LCP)")} value={seconds(lab.lcpMs)} rating={rate(lab.lcpMs, LIMITS.lcp)} />}
          {lab.tbtMs !== undefined && <Metric label={msg("Blocking time (TBT)")} value={millis(lab.tbtMs)} rating={rate(lab.tbtMs, LIMITS.tbt)} />}
          {lab.cls !== undefined && <Metric label={msg("Layout stays still (CLS)")} value={shift(lab.cls)} rating={rate(lab.cls, LIMITS.cls)} />}
          {lab.fcpMs !== undefined && <Metric label={msg("First content shows (FCP)")} value={seconds(lab.fcpMs)} rating={rate(lab.fcpMs, LIMITS.fcp)} />}
        </dl>
      </div>
    </>
  );
}

function Metric({ label, value, rating }: { label: string; value: string; rating: Rating }) {
  const t = useT();
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/6 py-1.5">
      <dt className="min-w-0 text-zinc-400">{t(label)}</dt>
      <dd className="shrink-0 tabular-nums">
        <span className="text-zinc-100">{value}</span> <span className={BAND_TEXT[rating]}>· {t(BAND_WORDS[rating])}</span>
      </dd>
    </div>
  );
}
