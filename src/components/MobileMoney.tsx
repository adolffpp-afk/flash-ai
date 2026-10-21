"use client";

import { useEffect, useState } from "react";
import { api, type Me } from "@/lib/store";
import { useT } from "@/lib/use-t";

type Prices = { country: string; currency: string; prices: Record<string, number> };

/**
 * Plans and top-ups paid with mobile money in Africa (see server/pawapay.ts). Plans are prepaid
 * passes of a month or a year: mobile money can't charge again without the buyer's PIN.
 */
export function MobileMoney({ me }: { me: Me }) {
  const t = useT();
  const mm = me.mobileMoney!;
  const [country, setCountry] = useState(mm.country || mm.countries[0]?.code || "");
  const [product, setProduct] = useState(`pass:${me.plans[1]?.id ?? me.plans[0]?.id}:month`);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api<Prices>(`/api/pawapay/prices?country=${country}`)
      .then((p) => live && setPrices(p))
      .catch((err) => live && setError(err instanceof Error ? err.message : t("Couldn't open checkout. Please try again.")));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  // What's over a country's largest mobile money payment has no price there, so it isn't offered.
  const offered = (id: string) => !prices || prices.country !== country || prices.prices[id] !== undefined;
  const amount = prices?.country === country ? prices.prices[product] : undefined;
  const price =
    amount !== undefined && prices
      ? new Intl.NumberFormat(t.locale, { style: "currency", currency: prices.currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(amount)
      : "";

  async function pay() {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ url: string }>("/api/pawapay/start", { method: "POST", json: { product, country } });
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't open checkout. Please try again."));
      setBusy(false);
    }
  }

  const field = "h-9 rounded-lg border border-white/10 bg-zinc-900 px-2 text-sm text-zinc-100";
  return (
    <div className="mt-3 rounded-xl border border-white/8 p-5">
      <p className="text-xs text-zinc-400">
        {t("M-Pesa, MTN, Airtel, Orange and more. A plan paid this way is prepaid for 1 month or 1 year and doesn't renew by itself.")}
        {mm.sandbox && <span className="ml-1 text-amber-400/80">{t("(test)")}</span>}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select aria-label={t("Country")} value={country} onChange={(e) => {
            setCountry(e.target.value);
            setError("");
          }} className={field}>
          {mm.countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label={t("Plans")} value={product} onChange={(e) => setProduct(e.target.value)} className={`${field} min-w-0 flex-1`}>
          {me.plans.filter((p) => offered(`pass:${p.id}:month`)).map((p) => (
            <option key={`${p.id}:month`} value={`pass:${p.id}:month`}>
              {t("{plan}, 1 month", { plan: p.name })}
            </option>
          ))}
          {me.plans.filter((p) => offered(`pass:${p.id}:year`)).map((p) => (
            <option key={`${p.id}:year`} value={`pass:${p.id}:year`}>
              {t("{plan}, 1 year", { plan: p.name })}
            </option>
          ))}
          {me.packs.filter((p) => offered(`pack:${p.id}`)).map((p) => (
            <option key={p.id} value={`pack:${p.id}`}>
              {`${p.name} · ${t("{count} credits", { count: p.credits.toLocaleString(t.locale) })}`}
            </option>
          ))}
        </select>
        <button
          onClick={pay}
          disabled={busy || !price}
          className="h-9 rounded-full bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? t("Opening…") : price ? t("Pay {price}", { price }) : "…"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-amber-300">{error}</p>}
    </div>
  );
}
