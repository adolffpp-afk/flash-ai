"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { SELLER_COUNTRIES } from "@/lib/shop";

type Site = { slug: string; title: string; updated_at: number; messages: number; unread: number; views: number };
type Visits = { days: { day: string; views: number; visitors: number }[]; views: number; visitors: number; sources: { source: string; views: number }[] };
type SiteMessage = { id: string; form: string; data: Record<string, unknown>; createdAt: number; read: boolean };
type DomainInfo = { domain: string; connected: boolean; records: { type: string; name: string; value: string }[] };
type Domains = { available: boolean; allowed: boolean; domains: DomainInfo[] };
type Seller = { connected: boolean; ready: boolean; currency: string; country: string };
type Payments = { available: boolean; allowed: boolean; seller: Seller };
type Product = { id: string; name: string; label: string; delivery: boolean };
type Order = { id: string; item: string; quantity: number; total: string; email: string; name: string; address: string; createdAt: number };
type Shop = { products: Product[]; unpriced: string[]; orders: Order[] };

const dateLabel = (t: number) =>
  new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fieldText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** My websites and apps: every published app, its link, and the forms visitors sent to it. */
export function MyApps({ onClose }: { onClose: () => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [open, setOpen] = useState<Site | null>(null);
  const [view, setView] = useState<"messages" | "domains" | "payments" | "visits">("messages");
  const [visits, setVisits] = useState<Visits | null>(null);
  const [payments, setPayments] = useState<Payments | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [country, setCountry] = useState("CA");
  const [item, setItem] = useState({ name: "", price: "", delivery: false });
  const [busy, setBusy] = useState(false);
  const [domains, setDomains] = useState<Domains | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [messages, setMessages] = useState<SiteMessage[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    api<{ sites: Site[] }>("/api/sites")
      .then(({ sites: list }) => setSites(list))
      .catch(() => {
        setError("Couldn't load your apps. Please try again.");
        setSites([]);
      });
  }, []);

  async function showDomains(site: Site) {
    setOpen(site);
    setView("domains");
    setDomains(null);
    setError("");
    try {
      setDomains(await api<Domains>(`/api/sites/${site.slug}/domains`));
    } catch {
      setError("Couldn't load the domains. Please try again.");
    }
  }

  async function connectDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!open || !newDomain.trim()) return;
    setAdding(true);
    setError("");
    try {
      const { domain } = await api<{ domain: DomainInfo }>(`/api/sites/${open.slug}/domains`, { method: "POST", json: { domain: newDomain } });
      setDomains((d) => d && { ...d, domains: [...d.domains.filter((x) => x.domain !== domain.domain), domain] });
      setNewDomain("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect that domain.");
    }
    setAdding(false);
  }

  async function disconnectDomain(domain: string) {
    if (!open) return;
    try {
      await api(`/api/sites/${open.slug}/domains?domain=${encodeURIComponent(domain)}`, { method: "DELETE" });
      setDomains((d) => d && { ...d, domains: d.domains.filter((x) => x.domain !== domain) });
    } catch {
      setError("Couldn't remove that domain. Please try again.");
    }
  }

  async function showPayments(site: Site) {
    setOpen(site);
    setView("payments");
    setPayments(null);
    setShop(null);
    setError("");
    try {
      const status = await api<Payments>("/api/payments");
      setPayments(status);
      if (status.seller.ready) setShop(await api<Shop>(`/api/sites/${site.slug}/products`));
    } catch {
      setError("Couldn't load payments. Please try again.");
    }
  }

  async function connectStripe() {
    setBusy(true);
    setError("");
    try {
      const { url } = await api<{ url: string }>("/api/payments", { method: "POST", json: { country } });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open Stripe.");
      setBusy(false);
    }
  }

  async function saveItem(e: React.FormEvent) {
    e.preventDefault();
    if (!open) return;
    setBusy(true);
    setError("");
    try {
      const { product } = await api<{ product: Product }>(`/api/sites/${open.slug}/products`, { method: "POST", json: item });
      setShop((s) =>
        s && {
          ...s,
          products: [...s.products.filter((p) => p.id !== product.id), product],
          unpriced: s.unpriced.filter((n) => n.toLowerCase() !== product.name.toLowerCase()),
        },
      );
      setItem({ name: "", price: "", delivery: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that item.");
    }
    setBusy(false);
  }

  async function removeItem(product: Product) {
    if (!open) return;
    try {
      await api(`/api/sites/${open.slug}/products?id=${encodeURIComponent(product.id)}`, { method: "DELETE" });
      setShop((s) => s && { ...s, products: s.products.filter((p) => p.id !== product.id) });
    } catch {
      setError("Couldn't remove that item. Please try again.");
    }
  }

  async function showVisits(site: Site) {
    setOpen(site);
    setView("visits");
    setVisits(null);
    setError("");
    try {
      setVisits(await api<Visits>(`/api/sites/${site.slug}/visits`));
    } catch {
      setError("Couldn't load the visitor stats. Please try again.");
    }
  }

  async function showMessages(site: Site) {
    setOpen(site);
    setView("messages");
    setMessages(null);
    setConfirming(null);
    try {
      const { messages: list } = await api<{ messages: SiteMessage[] }>(`/api/sites/${site.slug}/inbox`);
      setMessages(list);
      setSites((all) => all?.map((s) => (s.slug === site.slug ? { ...s, unread: 0 } : s)) ?? null);
    } catch {
      setError("Couldn't load the messages. Please try again.");
      setMessages([]);
    }
  }

  async function deleteMessage(id: string) {
    if (!open) return;
    try {
      await api(`/api/sites/${open.slug}/inbox?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setMessages((list) => list?.filter((m) => m.id !== id) ?? null);
      setSites((all) => all?.map((s) => (s.slug === open.slug ? { ...s, messages: s.messages - 1 } : s)) ?? null);
    } catch {
      setError("Couldn't delete that message. Please try again.");
    }
  }

  async function unpublish(slug: string) {
    try {
      await api(`/api/sites?slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
      setSites((all) => all?.filter((s) => s.slug !== slug) ?? null);
    } catch {
      setError("Couldn't unpublish that. Please try again.");
    }
    setConfirming(null);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="My websites and apps"
        className="flex h-full w-full max-w-3xl flex-col bg-zinc-950 text-zinc-100 sm:h-[80vh] sm:rounded-2xl sm:border sm:border-white/8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/6 px-5 py-4">
          {open && (
            <button onClick={() => setOpen(null)} className="text-sm text-zinc-400 hover:text-zinc-100" aria-label="Back to my apps">
              ←
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">
            {open ? `${{ domains: "Domain", payments: "Payments", messages: "Messages", visits: "Visitors" }[view]} · ${open.title}` : "My websites and apps"}
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}
          {open && view === "visits" ? (
            visits === null ? (
              !error && <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <VisitsView visits={visits} />
            )
          ) : open && view === "payments" ? (
            payments === null ? (
              !error && <p className="text-sm text-zinc-500">Loading…</p>
            ) : !payments.available ? (
              <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">Payments are coming soon.</p>
            ) : !payments.allowed ? (
              <p className="text-sm text-gold-soft">Selling from your sites comes with a paid plan. Pick one under your credits to start.</p>
            ) : !payments.seller.ready ? (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  Let visitors pay on this site with card, Apple Pay or Google Pay. The money goes straight to your own Stripe
                  account; Flash keeps 2% of each sale and Stripe takes its usual card fee.
                </p>
                {payments.seller.connected ? (
                  <p className="text-sm text-gold-soft">
                    Stripe still needs a few details before you can take payments. Finish the sign-up, then come back here.
                  </p>
                ) : (
                  <label className="block text-sm text-zinc-300">
                    Your business is in
                    <select
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="ml-2 h-9 rounded-lg border border-white/10 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-primary/70"
                    >
                      {SELLER_COUNTRIES.map(([code, name]) => (
                        <option key={code} value={code}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  onClick={connectStripe}
                  disabled={busy}
                  className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? "Opening Stripe…" : payments.seller.connected ? "Finish Stripe sign-up" : "Connect Stripe"}
                </button>
                <p className="text-xs text-zinc-500">
                  Stripe asks for your name, address and bank account so it can send you the money. Already have Stripe? Sign in
                  with it on the next page.
                </p>
              </div>
            ) : shop === null ? (
              !error && <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <div className="space-y-6">
                <p className="text-sm text-zinc-400">
                  Set a price for each item this site sells. Buyers pay with Stripe and the money goes to your Stripe account
                  (Flash keeps 2%). Ask Flash to add buy buttons to your site, then publish it again.
                </p>
                <section>
                  <h3 className="mb-2 text-sm font-medium text-zinc-200">For sale</h3>
                  {shop.products.length === 0 ? (
                    <p className="text-sm text-zinc-500">Nothing priced yet.</p>
                  ) : (
                    <ul className="divide-y divide-white/6 rounded-xl border border-white/8">
                      {shop.products.map((p) => (
                        <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                          <span className="min-w-0 flex-1 truncate text-zinc-100">{p.name}</span>
                          {p.delivery && <span className="text-xs text-zinc-500">🚚 delivery</span>}
                          <span className="tabular-nums text-zinc-200">{p.label}</span>
                          <button
                            onClick={() => setItem({ name: p.name, price: "", delivery: p.delivery })}
                            className="text-xs text-zinc-400 hover:text-white"
                          >
                            Change
                          </button>
                          <button onClick={() => removeItem(p)} className="text-xs text-zinc-500 hover:text-red-400">
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {shop.unpriced.length > 0 && (
                    <div className="mt-3 text-sm">
                      <p className="mb-1.5 text-xs text-gold-soft">Your site has buy buttons for these, but they have no price yet:</p>
                      <div className="flex flex-wrap gap-2">
                        {shop.unpriced.map((name) => (
                          <button
                            key={name}
                            onClick={() => setItem((i) => ({ ...i, name }))}
                            className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-200 hover:border-primary/60"
                          >
                            + {name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <form onSubmit={saveItem} className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      value={item.name}
                      onChange={(e) => setItem({ ...item, name: e.target.value })}
                      placeholder="Item name, as on your site"
                      aria-label="Item name"
                      className="h-10 min-w-0 flex-[2_1_12rem] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
                    />
                    <input
                      value={item.price}
                      onChange={(e) => setItem({ ...item, price: e.target.value })}
                      placeholder={`Price (${payments.seller.currency.toUpperCase()})`}
                      aria-label="Price"
                      inputMode="decimal"
                      className="h-10 w-32 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <input type="checkbox" checked={item.delivery} onChange={(e) => setItem({ ...item, delivery: e.target.checked })} />
                      Ask for a delivery address
                    </label>
                    <button
                      disabled={busy || !item.name.trim() || !item.price.trim()}
                      className="h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </form>
                </section>
                <section>
                  <h3 className="mb-2 text-sm font-medium text-zinc-200">Orders</h3>
                  {shop.orders.length === 0 ? (
                    <p className="text-sm text-zinc-500">No orders yet. You get an email for each one.</p>
                  ) : (
                    <ul className="space-y-2">
                      {shop.orders.map((o) => (
                        <li key={o.id} className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="text-zinc-100">
                              {o.quantity} × {o.item}
                            </span>
                            <span className="tabular-nums text-primary-soft">{o.total}</span>
                            <span className="ml-auto text-xs text-zinc-500">{dateLabel(o.createdAt)}</span>
                          </div>
                          <p className="mt-1 break-words text-xs text-zinc-400">
                            {[o.name, o.email, o.address].filter(Boolean).join(" · ")}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <a
                    href="https://dashboard.stripe.com/payments"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block text-xs text-primary-soft hover:underline"
                  >
                    Refunds and payouts are in your Stripe dashboard ↗
                  </a>
                </section>
              </div>
            )
          ) : open && view === "domains" ? (
            domains === null ? (
              !error && <p className="text-sm text-zinc-500">Loading…</p>
            ) : !domains.available ? (
              <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">Custom domains are coming soon.</p>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  Show this site on your own address, like yourbakery.com. Buy the domain anywhere (GoDaddy, Namecheap…),
                  connect it here, then add the record Flash shows at your domain provider. It can take up to a few hours to
                  start working.
                </p>
                {domains.domains.map((d) => (
                  <div key={d.domain} className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="font-medium text-zinc-100 hover:underline">
                        {d.domain}
                      </a>
                      <span className={`text-xs ${d.connected ? "text-primary-soft" : "text-gold-soft"}`}>
                        {d.connected ? "✓ Connected" : "Waiting for the DNS record"}
                      </span>
                      <span className="ml-auto flex gap-3 text-xs">
                        {!d.connected && (
                          <button onClick={() => showDomains(open)} className="text-zinc-300 hover:text-white">
                            Check again
                          </button>
                        )}
                        <button onClick={() => disconnectDomain(d.domain)} className="text-zinc-500 hover:text-red-400">
                          Remove
                        </button>
                      </span>
                    </div>
                    {!d.connected && d.records.length > 0 && (
                      <div className="mt-3 overflow-x-auto">
                        <p className="mb-2 text-xs text-zinc-400">At your domain provider, open the DNS settings and add:</p>
                        <table className="w-full text-left text-xs">
                          <thead className="text-zinc-500">
                            <tr>
                              <th className="py-1 pr-4 font-normal">Type</th>
                              <th className="py-1 pr-4 font-normal">Name</th>
                              <th className="py-1 font-normal">Value</th>
                            </tr>
                          </thead>
                          <tbody className="font-mono text-zinc-200">
                            {d.records.map((r) => (
                              <tr key={r.type + r.name + r.value}>
                                <td className="py-1 pr-4">{r.type}</td>
                                <td className="py-1 pr-4">{r.name}</td>
                                <td className="select-all break-all py-1">{r.value}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="mt-2 text-xs text-zinc-500">If a record with the same type and name is already there, edit it instead.</p>
                      </div>
                    )}
                  </div>
                ))}
                {domains.allowed ? (
                  <form onSubmit={connectDomain} className="flex gap-2">
                    <input
                      value={newDomain}
                      onChange={(e) => setNewDomain(e.target.value)}
                      placeholder="yourbakery.com"
                      aria-label="Domain"
                      className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
                    />
                    <button
                      disabled={adding || !newDomain.trim()}
                      className="h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                    >
                      {adding ? "Connecting…" : "Connect"}
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-gold-soft">Custom domains come with a paid plan. Pick one under your credits to connect a domain.</p>
                )}
                {domains.allowed && domains.domains.length > 0 && !domains.domains.some((d) => d.domain.startsWith("www.")) && (
                  <p className="text-xs text-zinc-500">Tip: connect the www. version too, so both addresses work.</p>
                )}
              </div>
            )
          ) : open ? (
            messages === null ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : messages.length === 0 ? (
              <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">
                No messages yet. When visitors send a contact or booking form on this site, it shows up here and you get an
                email.
              </p>
            ) : (
              <ul className="space-y-3">
                {messages.map((m) => (
                  <li key={m.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
                    <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                      <span className="rounded-full border border-white/10 px-2 py-0.5 text-zinc-300">{m.form}</span>
                      {!m.read && <span className="text-primary-soft">New</span>}
                      <span className="ml-auto">{dateLabel(m.createdAt)}</span>
                      <button onClick={() => deleteMessage(m.id)} className="hover:text-red-400" aria-label="Delete message">
                        🗑
                      </button>
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      {Object.entries(m.data).map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-zinc-500">{k}</dt>
                          <dd className="min-w-0 whitespace-pre-wrap break-words text-zinc-200">{fieldText(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            )
          ) : sites === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : sites.length === 0 ? (
            <div className="mx-auto mt-16 max-w-sm text-center">
              <p className="text-zinc-300">Nothing published yet.</p>
              <p className="mt-1 text-sm text-zinc-500">
                Ask Flash to build a website or app, then press Publish under the preview. It shows up here with its link
                and any messages visitors send.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {sites.map((s) => (
                <li key={s.slug} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-zinc-100">{s.title}</p>
                    <a href={`/p/${s.slug}`} target="_blank" rel="noreferrer" className="block truncate text-xs text-primary-soft hover:underline">
                      {typeof window !== "undefined" ? window.location.host : ""}/p/{s.slug}
                    </a>
                  </div>
                  {confirming === s.slug ? (
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-zinc-400">Take it offline, with its data and messages?</span>
                      <button onClick={() => unpublish(s.slug)} className="text-red-400 hover:text-red-300">
                        Unpublish
                      </button>
                      <button onClick={() => setConfirming(null)} className="text-zinc-400 hover:text-zinc-100">
                        Keep
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <button onClick={() => showMessages(s)} className="text-zinc-200 hover:text-white">
                        ✉️ Messages{s.messages ? ` (${s.messages})` : ""}
                        {s.unread > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-white">{s.unread} new</span>}
                      </button>
                      <button onClick={() => showVisits(s)} className="text-zinc-200 hover:text-white" title="Visits in the last 30 days">
                        📈 Visitors{s.views ? ` (${s.views.toLocaleString("en-US")})` : ""}
                      </button>
                      <button onClick={() => showDomains(s)} className="text-zinc-200 hover:text-white">
                        🔗 Domain
                      </button>
                      <button onClick={() => showPayments(s)} className="text-zinc-200 hover:text-white">
                        💳 Payments
                      </button>
                      <button onClick={() => setConfirming(s.slug)} className="text-zinc-500 hover:text-red-400">
                        Unpublish
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** A site's last 30 days: totals, a bar per day, and the websites visitors came from. */
function VisitsView({ visits }: { visits: Visits }) {
  if (visits.views === 0) {
    return (
      <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">
        No visitors yet. Share your site&apos;s link and each visit shows up here. Your own visits while signed in to Flash
        aren&apos;t counted.
      </p>
    );
  }
  const top = Math.max(...visits.days.map((d) => d.views));
  const today = visits.days[visits.days.length - 1];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        {[
          ["Visits", visits.views],
          ["Visitors", visits.visitors],
          ["Today", today.views],
        ].map(([label, n]) => (
          <div key={label} className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
            <p className="text-xs text-zinc-500">{label}</p>
            <p className="mt-1 text-2xl font-medium tabular-nums text-zinc-100">{Number(n).toLocaleString("en-US")}</p>
          </div>
        ))}
      </div>
      <div>
        <p className="mb-2 text-xs text-zinc-500">Visits per day, last 30 days</p>
        <div className="flex h-32 items-end gap-[3px]" role="img" aria-label={`${visits.views} visits in the last 30 days`}>
          {visits.days.map((d) => (
            <div
              key={d.day}
              title={`${dayLabel(d.day)}: ${d.views} visits, ${d.visitors} visitors`}
              className="min-w-0 flex-1 rounded-t-sm bg-primary/70 hover:bg-primary"
              style={{ height: d.views ? `${Math.max(4, (d.views / top) * 100)}%` : "2px", opacity: d.views ? 1 : 0.25 }}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
          <span>{dayLabel(visits.days[0].day)}</span>
          <span>Today</span>
        </div>
      </div>
      <div>
        <p className="mb-2 text-xs text-zinc-500">Where visitors came from</p>
        <ul className="divide-y divide-white/6 rounded-xl border border-white/8">
          {visits.sources.map((s) => (
            <li key={s.source} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="min-w-0 truncate text-zinc-200">{s.source || "Direct (typed, bookmarked or shared in a message)"}</span>
              <span className="tabular-nums text-zinc-400">{s.views.toLocaleString("en-US")}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-zinc-500">
        Counted without cookies. Visitors are people counted once a day; robots and your own visits are left out.
      </p>
    </div>
  );
}
