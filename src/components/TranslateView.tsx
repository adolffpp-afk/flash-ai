"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/store";
import { AFRICAN } from "@/lib/site-languages";
import { tNow, useT } from "@/lib/use-t";
import type { TranslationsView } from "@/lib/server/site-translations.ts";

type Done = { lang: string; credits: number; translated: number; missing: number; total: number };

/**
 * Translate my app, for one published app: the languages it's shown in, each with what is new on the
 * page since, and the languages to add, African ones first. Translate goes one language at a time,
 * each held at its "Up to" and charged what it used. onPlans opens the credit packs when it runs short.
 */
export function TranslateView({ slug, onPlans }: { slug: string; onPlans?: () => void }) {
  const t = useT();
  const [view, setView] = useState<TranslationsView | null>(null);
  const [error, setError] = useState("");
  const [short, setShort] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [find, setFind] = useState("");
  const [running, setRunning] = useState<{ lang: string; at: number; of: number } | null>(null);
  const [used, setUsed] = useState<number | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const alive = useRef(true);

  const load = () =>
    api<TranslationsView>(`/api/sites/${slug}/translations`).then(
      (v) => {
        if (alive.current) setView(v);
      },
      (err: unknown) => {
        if (alive.current) setError(err instanceof Error && err.message ? err.message : tNow("Couldn't load the languages. Please try again."));
      },
    );

  // Loaded once for each app.
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const labelOf = (id: string) => view?.choices.find((c) => c.id === id)?.label ?? id;
  const on = useMemo(() => new Set(view?.languages.map((l) => l.id)), [view]);
  const toAdd = useMemo(() => {
    const q = find.trim().toLowerCase();
    return (view?.choices ?? []).filter((c) => !on.has(c.id) && (!q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().startsWith(q)));
  }, [view, on, find]);

  /** Translates each language in turn: new ones, or what's new on the page for one already there. */
  async function translate(langs: string[]) {
    if (!view || running) return;
    setError("");
    setShort(false);
    setUsed(null);
    let total = 0;
    for (const [i, lang] of langs.entries()) {
      setRunning({ lang, at: i + 1, of: langs.length });
      try {
        const done = await api<Done>(`/api/sites/${slug}/translations`, { method: "POST", json: { lang } });
        total += done.credits;
        setPicked((p) => p.filter((x) => x !== lang));
      } catch (err) {
        const e = err as Error & { code?: string };
        setError(e.message || t("Flash couldn't translate that just now. Please try again."));
        setShort(e.code === "out_of_credits");
        break;
      }
    }
    if (!alive.current) return;
    setRunning(null);
    setUsed(total);
    await load();
  }

  async function remove(lang: string) {
    setError("");
    try {
      await api(`/api/sites/${slug}/translations?lang=${encodeURIComponent(lang)}`, { method: "DELETE" });
      setRemoving(null);
      await load();
    } catch {
      setError(t("Couldn't save that. Please try again."));
    }
  }

  if (!view) return error ? <p className="text-sm text-red-400">{error}</p> : <p className="text-sm text-zinc-500">{t("Loading…")}</p>;

  const count = (n: number) => n.toLocaleString(t.locale);
  const african = toAdd.filter((c) => AFRICAN.has(c.id));
  const more = toAdd.filter((c) => !AFRICAN.has(c.id));
  const room = view.max - view.languages.length;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < room ? [...p, id] : p));
  const chip = (c: { id: string; own: string; name: string }) => {
    const sel = picked.includes(c.id);
    return (
      <button
        key={c.id}
        type="button"
        aria-pressed={sel}
        disabled={Boolean(running)}
        onClick={() => toggle(c.id)}
        className={`flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm transition ${
          sel ? "border-primary/60 bg-primary/15 text-zinc-50" : "border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/20 hover:text-zinc-100"
        }`}
      >
        {sel && (
          <span aria-hidden className="text-primary-soft">
            ✓
          </span>
        )}
        <Name {...c} />
      </button>
    );
  };

  return (
    <div className="space-y-6 pb-24">
      <div className="rounded-2xl border border-white/8 bg-gradient-to-br from-primary/10 via-white/[0.02] to-transparent p-4">
        <p className="text-[15px] font-medium text-zinc-100">{t("Show your app in your visitors' languages")}</p>
        <p className="mt-1 text-sm text-zinc-400">
          {t("Visitors get a language button on your app, and it opens in their own language when you've added it. Your app keeps one design: only its words are translated.")}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {t("Written in {language}", { language: view.source.label })} · {t("{count} phrases", { count: count(view.phrases) })}
        </p>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          <span className="flex-1">{error}</span>
          {short && onPlans && (
            <button onClick={onPlans} className="h-8 rounded-lg bg-brand px-3 text-sm font-semibold text-on-brand hover:brightness-110">
              {t("Get more credits")}
            </button>
          )}
        </div>
      )}
      {used !== null && !error && (
        <p role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-300">
          {used === 1 ? t("Done. It used 1 credit.") : t("Done. It used {credits} credits.", { credits: count(used) })}
        </p>
      )}

      {view.languages.length > 0 && (
        <section>
          <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{t("Your languages")}</h3>
          <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
            {view.languages.map((l) => (
              <li key={l.id} className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                <span aria-hidden className="w-6 shrink-0 text-center text-lg">
                  🌐
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] text-zinc-100">
                    <Name {...l} />
                  </span>
                  <span className={`block text-xs ${l.missing ? "text-gold-soft" : "text-emerald-400"}`}>
                    {l.missing === 0
                      ? t("Up to date")
                      : l.missing === 1
                        ? t("1 new phrase to translate")
                        : t("{count} new phrases to translate", { count: count(l.missing) })}
                  </span>
                </span>
                {running?.lang === l.id ? (
                  <span className="text-xs text-zinc-400">{t("Translating…")}</span>
                ) : removing === l.id ? (
                  <span className="flex items-center gap-3 text-sm">
                    <button onClick={() => void remove(l.id)} className="text-red-400 hover:text-red-300">
                      {t("Remove")}
                    </button>
                    <button onClick={() => setRemoving(null)} className="text-zinc-400 hover:text-zinc-100">
                      {t("Keep")}
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-3 text-sm">
                    {l.missing > 0 && (
                      <button
                        disabled={Boolean(running)}
                        onClick={() => void translate([l.id])}
                        title={t("Up to {credits} credits, usually about {typical}.", { credits: count(l.most), typical: count(l.typical) })}
                        className="h-8 rounded-lg bg-brand px-3 font-semibold text-on-brand transition hover:brightness-110 disabled:opacity-50"
                      >
                        {t("Update")}
                      </button>
                    )}
                    <a href={`/p/${slug}?lang=${encodeURIComponent(l.id)}`} target="_blank" rel="noreferrer" className="text-primary-soft hover:underline">
                      {t("See it")}
                    </a>
                    <button disabled={Boolean(running)} onClick={() => setRemoving(l.id)} className="text-zinc-500 hover:text-red-400" aria-label={t("Remove {language}", { language: l.label })}>
                      ✕
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {room > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-3 px-1">
            <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{t("Add languages")}</h3>
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={t("Find a language")}
              aria-label={t("Find a language")}
              className="h-8 w-40 rounded-lg border border-white/10 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/50"
            />
          </div>
          {african.length > 0 && (
            <>
              <p className="mb-2 px-1 text-xs text-zinc-500">{t("African languages")}</p>
              <div className="mb-4 flex flex-wrap gap-2">{african.map(chip)}</div>
            </>
          )}
          {more.length > 0 && (
            <>
              <p className="mb-2 px-1 text-xs text-zinc-500">{t("More languages")}</p>
              <div className="flex flex-wrap gap-2">{more.map(chip)}</div>
            </>
          )}
        </section>
      )}

      {(picked.length > 0 || running) && (
        <div className="sticky bottom-0 -mx-4 border-t border-white/8 bg-zinc-950/95 px-4 py-3 backdrop-blur sm:-mx-5 sm:px-5">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-[1_1_14rem] text-xs text-zinc-400">
              {running
                ? t("Translating into {language}… ({at} of {count})", { language: labelOf(running.lang), at: running.at, count: running.of })
                : t("Up to {credits} credits a language, usually about {typical}. You only pay for what it uses.", {
                    credits: count(view.most),
                    typical: count(view.typical),
                  })}
            </p>
            <button
              disabled={Boolean(running)}
              onClick={() => void translate(picked)}
              className="h-10 rounded-xl bg-brand px-5 text-sm font-semibold text-on-brand shadow-lg shadow-primary/20 transition hover:brightness-110 disabled:opacity-60"
            >
              {running
                ? t("Translating…")
                : picked.length === 1
                  ? t("Translate into 1 language")
                  : t("Translate into {count} languages", { count: count(picked.length) })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A language by its own name, kept whole in its own direction, with the English name after it where that helps. */
function Name({ id, own, name }: { id: string; own: string; name: string }) {
  return (
    <span>
      <bdi lang={id}>{own}</bdi>
      {own !== name && <span className="text-zinc-500"> ({name})</span>}
    </span>
  );
}
