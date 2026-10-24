"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import type { Me } from "@/lib/store";
import { PLAY_PACKS } from "@/lib/credits";
import { buyOnPlay, playPrices, playTrouble, unfinishedPurchases } from "@/lib/play-billing";
import { useT } from "@/lib/use-t";

/**
 * Top-ups inside the Android app, paid through Google Play (Play's billing rule; see android-shell.ts and
 * server/play-billing.ts). Shown only where Play's purchase sheet exists and the server can check purchases,
 * with the prices Play itself shows. The website's Stripe buttons never appear here.
 */
export function PlayTopUp({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const t = useT();
  const [prices, setPrices] = useState<Record<string, string> | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function credit(sku: string, token: string) {
    const res = await api<{ added?: boolean; pending?: boolean }>("/api/billing/play", { method: "POST", json: { sku, token } });
    return res;
  }

  useEffect(() => {
    if (!me.playBilling) return;
    let live = true;
    void (async () => {
      const got = await playPrices();
      if (!live) return;
      setPrices(got);
      setChecked(true);
      if (!got) return;
      // Paid but never credited (the app closed first): the server checks each again, and never credits twice.
      let added = false;
      for (const p of await unfinishedPurchases()) {
        try {
          if ((await credit(p.sku, p.token)).added) added = true;
        } catch {
          // Asked again the next time this opens.
        }
      }
      if (added && live) onChanged();
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.playBilling]);

  // Why the packs aren't here, for admins only (their words aren't translated; customers see nothing).
  if (!me.playBilling || !prices) {
    if (!me.isAdmin) return null;
    return (
      <p className="mt-10 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-400">
        {me.playBilling
          ? (checked ? playTrouble : "Looking for Google Play prices…")
          : "Buying in the app isn't open to this account: the Play service account key is missing on the server (redeploy after adding it), or this email isn't in FLASH_ADMIN_EMAILS / FLASH_PLAY_TESTERS."}
      </p>
    );
  }

  async function buy(packId: string, sku: string) {
    setBusy(packId);
    setMessage("");
    try {
      const token = await buyOnPlay(sku);
      if (!token) return;
      const res = await credit(sku, token);
      // A slow payment method answers "pending": the credits come once Google confirms it, when this next opens.
      if (!res.pending) {
        setMessage(t("Thanks! Your credits were added."));
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("Couldn't start checkout."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h3 className="mt-10 text-xs font-medium uppercase tracking-wider text-zinc-500">{t("Top up")}</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {PLAY_PACKS.map((play, i) => {
          const pack = me.packs.find((p) => p.id === play.id);
          if (!pack || !prices[play.id]) return null;
          return (
            <div key={play.id} className={`flex flex-col rounded-xl border p-5 ${i === 1 ? "border-white/15 bg-white/[0.025]" : "border-white/8"}`}>
              <span className="font-medium">{pack.name}</span>
              <div className="mt-1 text-2xl font-medium tracking-tight">{prices[play.id]}</div>
              <div className="text-sm text-zinc-400">{t("{count} credits", { count: pack.credits.toLocaleString(t.locale) })}</div>
              <p className="mb-3 mt-2 text-xs text-zinc-500">{t(pack.blurb)}</p>
              <button
                onClick={() => buy(play.id, play.sku)}
                disabled={busy !== null}
                className="mt-auto h-9 w-full rounded-full bg-brand text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
              >
                {busy === play.id ? t("Opening…") : t("Buy")}
              </button>
            </div>
          );
        })}
      </div>
      {message && <p className="mt-3 text-sm text-amber-300">{message}</p>}
    </>
  );
}
