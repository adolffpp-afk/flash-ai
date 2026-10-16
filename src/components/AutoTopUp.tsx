"use client";

import { useEffect, useState } from "react";
import { api, type Me } from "@/lib/store";
import { useT } from "@/lib/use-t";

type Settings = { enabled: boolean; pack: string; below: number; card: boolean; failed: string; thisMonth: number; maxPerMonth: number };

// The levels the server accepts (TOP_UP_LEVELS in auto-topup.ts).
const LEVELS = [100, 300, 1000];
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/** Credits > Top up: buy a pack with a saved card whenever the balance runs low. */
export function AutoTopUp({ packs }: { packs: Me["packs"] }) {
  const t = useT();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Settings>("/api/billing/auto-topup").then(setS, () => {});
  }, []);

  async function save(next: Pick<Settings, "enabled" | "pack" | "below">) {
    setBusy(true);
    setError("");
    try {
      const res = await api<Settings & { url?: string }>("/api/billing/auto-topup", { method: "POST", json: next });
      // No card saved yet: Stripe's page saves one, and auto top-up is on when it's done.
      if (res.url) window.location.assign(res.url);
      else setS(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  if (!s) return null;
  const select = "h-8 rounded-lg border border-white/10 bg-zinc-900 px-2 text-xs text-zinc-200 disabled:opacity-50";
  return (
    <div className="mt-4 rounded-xl border border-white/8 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={busy}
            onChange={(e) => save({ enabled: e.target.checked, pack: s.pack, below: s.below })}
          />
          {t("Top up automatically")}
        </label>
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <select
            aria-label={t("Pack")}
            className={select}
            value={s.pack}
            disabled={busy}
            onChange={(e) => save({ enabled: s.enabled, pack: e.target.value, below: s.below })}
          >
            {packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {money(p.priceCents)} · {t("{count} credits", { count: p.credits.toLocaleString(t.locale) })}
              </option>
            ))}
          </select>
          <span>{t("When your balance falls below")}</span>
          <select
            aria-label={t("When your balance falls below")}
            className={select}
            value={s.below}
            disabled={busy}
            onChange={(e) => save({ enabled: s.enabled, pack: s.pack, below: Number(e.target.value) })}
          >
            {LEVELS.map((n) => (
              <option key={n} value={n}>
                {t("{count} credits", { count: n.toLocaleString(t.locale) })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {t("At most {max} top-ups a month, with the card you save. Turn it off any time.", { max: s.maxPerMonth })}
      </p>
      {s.failed && !s.enabled && <p className="mt-2 text-xs text-amber-300">{t("Auto top-up stopped: {reason}", { reason: s.failed })}</p>}
      {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}
    </div>
  );
}
