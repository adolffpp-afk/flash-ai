"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import { useT } from "@/lib/use-t";

// levels: the ones the server accepts (ALERT_LEVELS in low-balance.ts). emails: whether Flash can send any.
type Settings = { enabled: boolean; below: number; levels: number[]; emails: boolean };

/**
 * Credits > Top up: an email when a spend takes the balance below a level, and when an app's AI
 * turns visitors away for lack of credits (see low-balance.ts). On until the person turns it off.
 */
export function LowCreditEmails({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Settings>("/api/billing/low-credit-emails").then(setS, () => {});
  }, []);

  async function save(next: Pick<Settings, "enabled" | "below">) {
    setBusy(true);
    setError("");
    try {
      setS(await api<Settings>("/api/billing/low-credit-emails", { method: "POST", json: next }));
      // The bell and Home say "running low" at the same level.
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  if (!s?.emails) return null;
  return (
    <div className="mt-3 rounded-xl border border-white/8 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked, below: s.below })} />
          {t("Email me when my credits run low")}
        </label>
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span>{t("When your balance falls below")}</span>
          <select
            aria-label={t("When your balance falls below")}
            className="h-8 rounded-lg border border-white/10 bg-zinc-900 px-2 text-xs text-zinc-200 disabled:opacity-50"
            value={s.below}
            disabled={busy}
            onChange={(e) => save({ enabled: s.enabled, below: Number(e.target.value) })}
          >
            {s.levels.map((n) => (
              <option key={n} value={n}>
                {t("{count} credits", { count: n.toLocaleString(t.locale) })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {t("One email each time your balance drops below it (at most one a week), and one when your credits run out. None while auto top-up is on. Flash also emails you, at most once a day, when an app's AI can't answer its visitors because you're out of credits.")}
      </p>
      {error && <p className="mt-2 text-xs text-amber-300">{error}</p>}
    </div>
  );
}
