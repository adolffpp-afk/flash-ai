"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { REGISTRANT_COUNTRIES, searchKeyword, usd } from "@/lib/domain-price";

// What /api/domains/search and /api/domains/orders answer (see server/domain-orders.ts).
type Offer = { domain: string; priceCents: number; renewalPriceCents: number };
export type DomainOrderView = {
  id: string;
  domain: string;
  status: "waiting" | "buying" | "setting-up" | "live" | "not-bought";
  priceCents: number;
  sandbox: boolean;
  createdAt: number;
  renewal?: boolean;
};
// A domain the user has from Flash (see server/domain-checks.ts).
export type OwnedDomainView = {
  domain: string;
  expiresAt: number;
  verified: boolean;
  renewPriceCents: number;
  status: "active" | "expired" | "moved";
  sandbox: boolean;
  canRenew: boolean;
};
type Contact = Record<"firstName" | "lastName" | "companyName" | "address1" | "address2" | "city" | "state" | "zip" | "country" | "email" | "phone", string>;

const EMPTY: Contact = { firstName: "", lastName: "", companyName: "", address1: "", address2: "", city: "", state: "", zip: "", country: "", email: "", phone: "" };
const input = "h-10 w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70";
const button = "h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50";

/**
 * Buying a domain for a site inside Flash: search, the registrant's details, a review, then Stripe
 * Checkout (which only holds the card), and the order's progress until the domain is live. In
 * Name.com's sandbox (sandbox), nothing is really bought or paid. Also the domains the user already
 * has from Flash for the site (owned): when each ends, Renew now, and Name.com's confirmation email.
 * canBuy: whether the user can buy a new one (owned domains show either way).
 */
export function BuyDomain({
  site,
  sandbox,
  canBuy,
  orders,
  owned,
  email,
  onChange,
}: {
  site: { slug: string; title: string };
  sandbox: boolean;
  canBuy: boolean;
  orders: DomainOrderView[];
  owned: OwnedDomainView[];
  email?: string;
  onChange: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState(() => searchKeyword(site.title));
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [picked, setPicked] = useState<Offer | null>(null);
  const [contact, setContact] = useState<Contact>({ ...EMPTY, email: email ?? "" });
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The orders shown, from when the Domain view opened (it opens afresh for each site).
  const [following, setFollowing] = useState<DomainOrderView[]>(orders);

  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([t.locale], { type: "region" });
    return REGISTRANT_COUNTRIES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, t.locale));
  }, [t.locale]);

  // Orders still on their way are asked about every few seconds; asking also takes them a step on.
  const waiting = following.filter((o) => o.status === "buying" || o.status === "setting-up" || o.status === "waiting");
  useEffect(() => {
    if (!waiting.length) return;
    const timer = setTimeout(async () => {
      const fresh = await Promise.all(
        waiting.map((o) => api<{ order: DomainOrderView }>(`/api/domains/orders/${o.id}`).then((r) => r.order, () => o)),
      );
      setFollowing((list) => list.map((o) => fresh.find((f) => f.id === o.id) ?? o));
      if (fresh.some((f) => f.status === "live")) onChange();
    }, 5000);
    return () => clearTimeout(timer);
  }, [waiting, onChange]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    setPicked(null);
    try {
      const found = await api<{ offers: Offer[] }>(`/api/domains/search?q=${encodeURIComponent(query)}`);
      setOffers(found.offers);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't search for names right now. Please try again."));
    }
    setBusy(false);
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const started = await api<{ url?: string; order: string }>("/api/domains/checkout", {
        method: "POST",
        json: { domain: picked.domain, siteSlug: site.slug, contact, accepted },
      });
      if (started.url) {
        window.location.href = started.url;
        return;
      }
      setFollowing((list) => [
        { id: started.order, domain: picked.domain, status: "buying", priceCents: picked.priceCents, sandbox, createdAt: Date.now() },
        ...list,
      ]);
      setPicked(null);
      setOffers(null);
      setAccepted(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't open checkout. Please try again."));
    }
    setBusy(false);
  }

  async function renew(d: OwnedDomainView) {
    setBusy(true);
    setError("");
    try {
      const started = await api<{ url?: string; order: string }>(`/api/domains/owned/${encodeURIComponent(d.domain)}/renew`, { method: "POST" });
      if (started.url) {
        window.location.assign(started.url);
        return;
      }
      setFollowing((list) => [
        { id: started.order, domain: d.domain, status: "buying", priceCents: d.renewPriceCents, sandbox: d.sandbox, createdAt: Date.now(), renewal: true },
        ...list,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't open checkout. Please try again."));
    }
    setBusy(false);
  }

  const [resent, setResent] = useState<string[]>([]);
  async function resend(domain: string) {
    setError("");
    try {
      await api(`/api/domains/owned/${encodeURIComponent(domain)}/verify-email`, { method: "POST" });
      setResent((list) => [...list, domain]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't send the email again. Please try later."));
    }
  }

  const set = (key: keyof Contact) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setContact((c) => ({ ...c, [key]: e.target.value }));
  const progress = (o: DomainOrderView) =>
    o.status === "waiting"
      ? t("Waiting for the payment")
      : o.status === "buying"
        ? o.renewal
          ? t("Renewing…")
          : t("Registering…")
        : o.status === "setting-up"
          ? t("Connecting to your site…")
          : o.status === "live"
            ? o.renewal
              ? t("Renewed for one more year.")
              : t("Registered and connected. HTTPS starts within a few minutes.")
            : t("Not bought. You were not charged; your bank may show the hold for a few days.");

  return (
    <div className="space-y-3 rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
      {canBuy && (
        <div>
          <p className="font-medium text-zinc-100">{t("Get your own address, like goldencrumb.com")}</p>
          <p className="mt-1 text-xs text-zinc-400">{t("Flash buys it in your name and connects it to this site for you. There are no DNS steps.")}</p>
          {sandbox && <p className="mt-1 text-xs text-gold-soft">{t("Test mode: names are bought in Name.com's sandbox. Nothing is really bought or paid.")}</p>}
        </div>
      )}

      {owned.map((d) => (
        <div key={d.domain} className="space-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium text-zinc-100">{d.domain}</span>
            <span className={d.status === "expired" ? "text-xs text-red-400" : "text-xs text-zinc-400"}>
              {d.status === "expired"
                ? t("Ended on {date}", { date: new Date(d.expiresAt).toLocaleDateString(t.locale) })
                : t("Yours until {date}", { date: new Date(d.expiresAt).toLocaleDateString(t.locale) })}
            </span>
            {d.canRenew && d.status === "active" && (
              <button onClick={() => renew(d)} disabled={busy} className="ml-auto text-sm text-primary-soft hover:underline disabled:opacity-50">
                {t("Renew for 1 year: {price}", { price: usd(d.renewPriceCents) })}
              </button>
            )}
          </div>
          {!d.verified && d.status === "active" && (
            <p className="text-xs text-gold-soft">
              {t("Check your email for a message from Name.com and click its link, or the domain will be paused.")}{" "}
              {resent.includes(d.domain) ? (
                <span className="text-zinc-400">{t("Sent again.")}</span>
              ) : (
                <button onClick={() => resend(d.domain)} className="text-primary-soft hover:underline">
                  {t("Send it again")}
                </button>
              )}
            </p>
          )}
        </div>
      ))}

      {following.map((o) => (
        <div key={o.id} className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2 text-sm">
          <span className="font-medium text-zinc-100">{o.domain}</span>{" "}
          <span className={o.status === "live" ? "text-primary-soft" : o.status === "not-bought" ? "text-red-400" : "text-gold-soft"}>{progress(o)}</span>
        </div>
      ))}

      {canBuy && !picked && (
        <form onSubmit={search} className="flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="goldencrumb" aria-label={t("Name to search")} className={input} />
          <button disabled={busy || !query.trim()} className={button}>
            {busy ? t("Searching…") : t("Search")}
          </button>
        </form>
      )}

      {canBuy && !picked && offers && (offers.length === 0 ? (
        <p className="text-sm text-zinc-400">{t("No free names found for that. Try another word.")}</p>
      ) : (
        <ul className="space-y-2">
          {offers.map((o) => (
            <li key={o.domain} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
              <span className="font-medium text-zinc-100">{o.domain}</span>
              <span className="text-xs text-zinc-400">
                {t("{price} for the first year, then {renewal} a year", { price: usd(o.priceCents), renewal: usd(o.renewalPriceCents) })} · {t("Privacy included")}
              </span>
              <button onClick={() => setPicked(o)} className="ml-auto text-sm text-primary-soft hover:underline">
                {t("Choose")}
              </button>
            </li>
          ))}
        </ul>
      ))}

      {picked && (
        <form onSubmit={pay} className="space-y-3">
          <p className="text-sm text-zinc-200">
            <span className="font-medium">{picked.domain}</span>{" "}
            <button type="button" onClick={() => setPicked(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
              {t("Change")}
            </button>
          </p>
          <p className="text-xs text-zinc-400">{t("The domain is registered in your name. Your name and details go on its registration, kept private where the ending allows it.")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input required value={contact.firstName} onChange={set("firstName")} placeholder={t("First name")} aria-label={t("First name")} className={input} />
            <input required value={contact.lastName} onChange={set("lastName")} placeholder={t("Last name")} aria-label={t("Last name")} className={input} />
            <input value={contact.companyName} onChange={set("companyName")} placeholder={t("Business name (optional)")} aria-label={t("Business name (optional)")} className={`${input} sm:col-span-2`} />
            <input required type="email" value={contact.email} onChange={set("email")} placeholder={t("Email")} aria-label={t("Email")} className={input} />
            <input required type="tel" value={contact.phone} onChange={set("phone")} placeholder="+1 514 555 0100" aria-label={t("Phone with country code")} className={input} />
            <input required value={contact.address1} onChange={set("address1")} placeholder={t("Street address")} aria-label={t("Street address")} className={`${input} sm:col-span-2`} />
            <input value={contact.address2} onChange={set("address2")} placeholder={t("Apartment, suite (optional)")} aria-label={t("Apartment, suite (optional)")} className={`${input} sm:col-span-2`} />
            <input required value={contact.city} onChange={set("city")} placeholder={t("City")} aria-label={t("City")} className={input} />
            <input required value={contact.state} onChange={set("state")} placeholder={t("Province or state")} aria-label={t("Province or state")} className={input} />
            <input required value={contact.zip} onChange={set("zip")} placeholder={t("Postal code")} aria-label={t("Postal code")} className={input} />
            <select required value={contact.country} onChange={set("country")} aria-label={t("Country")} className={input}>
              <option value="">{t("Country")}</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3 text-xs text-zinc-300">
            <p className="text-sm text-zinc-100">
              {t("{domain}: {price} for 1 year. Next year: {renewal}, and we tell you before charging if the registry changes it.", {
                domain: picked.domain,
                price: usd(picked.priceCents),
                renewal: usd(picked.renewalPriceCents),
              })}
            </p>
            <p className="mt-2">{t("Name.com, the registrar, will email you to confirm your details. Click its link within 15 days, or the domain is paused.")}</p>
            <p className="mt-1">{t("A registered domain can't be refunded. You can move it to another registrar after 60 days.")}</p>
            <label className="mt-2 flex items-start gap-2">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5" />
              <span>
                {t("I accept the domain terms and Name.com's registration agreement.")}{" "}
                <a href="https://www.name.com/policies/legal" target="_blank" rel="noreferrer" className="text-primary-soft hover:underline">
                  {t("Read them")} ↗
                </a>
              </span>
            </label>
          </div>
          <button disabled={busy || !accepted} className={button}>
            {busy ? t("Opening checkout…") : sandbox ? t("Buy in test mode") : t("Pay with Stripe")}
          </button>
          {!sandbox && <p className="text-xs text-zinc-500">{t("Your card is only held. It is charged once the domain is registered, and let go if it can't be.")}</p>}
        </form>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
