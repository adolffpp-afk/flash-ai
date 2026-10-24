"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { AFRICAN } from "@/lib/site-languages";
import { useT } from "@/lib/use-t";
import { ICONS } from "./Home";

type Language = { id: string; own: string; name: string };
type Recent = { id: string; url: string; title: string; lang: string; created_at: number };
type Check = { url: string; title: string; phrases: number; from: string; most: number; typical: number };
type Done = { link: string; title: string; credits: number; missing: number };

/**
 * Translate a website: paste any page's link, pick a language, see what it costs, and get the page
 * translated at a link of its own (see server/page-translations.ts). onPlans opens the credit packs.
 */
export function TranslateWebsite({ onClose, onPlans }: { onClose: () => void; onPlans?: () => void }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [url, setUrl] = useState("");
  const [lang, setLang] = useState(t.language !== "en" ? t.language : "fr");
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "translate">("");
  const [error, setError] = useState("");
  const [short, setShort] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    api<{ languages: Language[]; recent: Recent[] }>("/api/translate-page").then(
      (r) => {
        if (!live) return;
        setLanguages(r.languages);
        setRecent(r.recent);
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, []);

  async function send(step: "check" | "translate", to = lang) {
    if (!url.trim() || busy) return;
    setBusy(step);
    setError("");
    setShort(false);
    if (step === "check") {
      setCheck(null);
      setDone(null);
    }
    try {
      if (step === "check") setCheck(await api<Check>("/api/translate-page", { method: "POST", json: { url, lang: to, check: true } }));
      else {
        const d = await api<Done & { id: string; url: string; lang: string }>("/api/translate-page", { method: "POST", json: { url, lang: to } });
        setDone(d);
        setRecent((r) => [{ id: d.id, url: d.url, title: d.title, lang: d.lang, created_at: Date.now() }, ...r.filter((x) => x.id !== d.id)].slice(0, 10));
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      setError(e.message);
      setShort(e.code === "out_of_credits");
    } finally {
      setBusy("");
    }
  }

  const count = (n: number) => n.toLocaleString(t.locale);
  const ownOf = (id: string) => languages.find((l) => l.id === id);
  const sorted = [...languages.filter((l) => AFRICAN.has(l.id)), ...languages.filter((l) => !AFRICAN.has(l.id))];
  const input = "h-11 w-full rounded-xl border border-white/10 bg-zinc-900 px-3.5 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/50";

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="translate-website-title"
        className="flex max-h-[92dvh] w-full max-w-xl flex-col rounded-t-3xl border border-white/8 bg-zinc-950 text-zinc-100 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-6 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-500 text-white shadow-lg shadow-indigo-500/20">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={ICONS.translate} />
              </svg>
            </span>
            <div className="min-w-0">
              <h2 id="translate-website-title" className="text-xl font-semibold tracking-tight">
                {t("Translate a website")}
              </h2>
              <p className="mt-0.5 text-sm leading-relaxed text-zinc-400">{t("Paste any page's link and read it in your language.")}</p>
            </div>
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>

        <form
          className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6 pt-3 sm:px-7"
          onSubmit={(e) => {
            e.preventDefault();
            void send(check && check.url && !done ? "translate" : "check");
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">{t("Website link")}</span>
            <input
              type="text"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="url"
              required
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setCheck(null);
                setDone(null);
              }}
              placeholder="https://example.com"
              className={input}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">{t("Translate into")}</span>
            <select
              value={lang}
              onChange={(e) => {
                setLang(e.target.value);
                setDone(null);
                if (check) void send("check", e.target.value);
              }}
              className={input}
            >
              {sorted.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.own === l.name ? l.own : `${l.own} (${l.name})`}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
              <span className="flex-1">{error}</span>
              {short && onPlans && (
                <button type="button" onClick={onPlans} className="h-8 rounded-lg bg-brand px-3 text-sm font-semibold text-on-brand hover:brightness-110">
                  {t("Get more credits")}
                </button>
              )}
            </div>
          )}

          {check && (
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
              <p className="truncate text-[15px] font-medium text-zinc-100">
                <bdi>{check.title || new URL(check.url).hostname}</bdi>
              </p>
              <p className="truncate text-xs text-zinc-500">{check.url}</p>
              <p className="mt-2 text-sm text-zinc-400">
                {t("{count} phrases", { count: count(check.phrases) })} ·{" "}
                {t("Up to {credits} credits, usually about {typical}.", { credits: count(check.most), typical: count(check.typical) })}
              </p>
            </div>
          )}

          {done && (
            <p role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-300">
              {done.credits === 1 ? t("Done. It used 1 credit.") : t("Done. It used {credits} credits.", { credits: count(done.credits) })}{" "}
              <a href={done.link} target="_blank" rel="noopener" className="font-semibold underline">
                {t("Open the translated page")}
              </a>
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={Boolean(busy) || !url.trim()}
              className="h-11 flex-1 rounded-xl bg-brand px-5 text-sm font-semibold text-on-brand shadow-lg shadow-primary/20 transition hover:brightness-110 disabled:opacity-60"
            >
              {busy === "check"
                ? t("Reading the page…")
                : busy === "translate"
                  ? t("Translating…")
                  : check && !done
                    ? t("Translate into {language}", { language: ownOf(lang)?.own ?? lang })
                    : t("Check the page")}
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            {t("You see the price before anything is charged, and pay only what it uses. The translated page is yours to share for a month. Its own buttons and forms don't work in the copy.")}
          </p>

          {recent.length > 0 && (
            <section>
              <h3 className="mb-2 mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{t("Recent translations")}</h3>
              <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
                {recent.map((r) => (
                  <li key={r.id}>
                    <a href={`/t/${r.id}`} target="_blank" rel="noopener" className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-white/[0.04]">
                      <span className="min-w-0 flex-1">
                        <bdi className="block truncate text-sm text-zinc-100">{r.title || r.url}</bdi>
                        <span className="block truncate text-xs text-zinc-500">{r.url}</span>
                      </span>
                      <bdi lang={r.lang} className="shrink-0 text-xs text-zinc-400">
                        {ownOf(r.lang)?.own ?? r.lang}
                      </bdi>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </form>
      </div>
    </div>
  );
}
