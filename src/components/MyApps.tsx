"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { SELLER_COUNTRIES } from "@/lib/shop";
import { msg } from "@/lib/i18n";
import { tNow, useT, type T } from "@/lib/use-t";

type Site = { slug: string; title: string; updated_at: number; messages: number; unread: number; views: number; members: number };
type Member = { id: string; email: string; name: string; createdAt: number };
type Ai = { enabled: boolean; dailyCredits: number; usedToday: number; askedToday: number };
type Upload = { id: string; name: string; mime: string; size: number; createdAt: number; url: string };
type Uploads = { files: Upload[]; use: { files: number; bytes: number; maxFiles: number; maxBytes: number }; enabled: boolean };
type Version = { id: string; title: string; createdAt: number; size: number };
type Visits = { days: { day: string; views: number; visitors: number }[]; views: number; visitors: number; sources: { source: string; views: number }[] };
type SiteMessage = { id: string; form: string; data: Record<string, unknown>; createdAt: number; read: boolean };
type DomainInfo = { domain: string; connected: boolean; records: { type: string; name: string; value: string }[] };
type Domains = { available: boolean; allowed: boolean; domains: DomainInfo[] };
type Seller = { connected: boolean; ready: boolean; currency: string; country: string };
type Payments = { available: boolean; allowed: boolean; seller: Seller };
type Product = { id: string; name: string; label: string; delivery: boolean };
type Order = { id: string; item: string; quantity: number; total: string; email: string; name: string; address: string; createdAt: number; done: boolean };
type Shop = { products: Product[]; unpriced: string[]; orders: Order[] };

const dateLabel = (when: number, locale: string) =>
  new Date(when).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayLabel = (day: string, locale: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
const fieldText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
// Written like toFixed: no thousands separator, so English reads as before.
const plain = (n: number, locale: string, digits = 0) =>
  n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
const sizeLabel = (bytes: number, t: T) =>
  bytes >= 1024 * 1024
    ? t("{size} MB", { size: plain(bytes / 1024 / 1024, t.locale, 1) })
    : t("{size} KB", { size: plain(Math.max(1, Math.round(bytes / 1024)), t.locale) });

// The heading over each part of an app.
const VIEW_TITLES = {
  domains: msg("Domain"),
  payments: msg("Payments"),
  messages: msg("Messages"),
  visits: msg("Visitors"),
  history: msg("History"),
  members: msg("Members"),
  ai: msg("AI"),
  files: msg("Files"),
};

/** My websites and apps: every published app, its link, and the forms visitors sent to it. */
export function MyApps({ onClose, onEdit }: { onClose: () => void; onEdit?: (projectId: string) => void }) {
  const t = useT();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [open, setOpen] = useState<Site | null>(null);
  const [view, setView] = useState<"messages" | "domains" | "payments" | "visits" | "history" | "members" | "ai" | "files">("messages");
  const [members, setMembers] = useState<Member[] | null>(null);
  const [ai, setAi] = useState<Ai | null>(null);
  const [uploads, setUploads] = useState<Uploads | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
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
        setError(tNow("Couldn't load your apps. Please try again."));
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
      setError(t("Couldn't load the domains. Please try again."));
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
      setError(err instanceof Error ? err.message : t("Couldn't connect that domain."));
    }
    setAdding(false);
  }

  async function disconnectDomain(domain: string) {
    if (!open) return;
    try {
      await api(`/api/sites/${open.slug}/domains?domain=${encodeURIComponent(domain)}`, { method: "DELETE" });
      setDomains((d) => d && { ...d, domains: d.domains.filter((x) => x.domain !== domain) });
    } catch {
      setError(t("Couldn't remove that domain. Please try again."));
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
      setError(t("Couldn't load payments. Please try again."));
    }
  }

  async function connectStripe() {
    setBusy(true);
    setError("");
    try {
      const { url } = await api<{ url: string }>("/api/payments", { method: "POST", json: { country } });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't open Stripe."));
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
      setError(err instanceof Error ? err.message : t("Couldn't save that item."));
    }
    setBusy(false);
  }

  async function removeItem(product: Product) {
    if (!open) return;
    try {
      await api(`/api/sites/${open.slug}/products?id=${encodeURIComponent(product.id)}`, { method: "DELETE" });
      setShop((s) => s && { ...s, products: s.products.filter((p) => p.id !== product.id) });
    } catch {
      setError(t("Couldn't remove that item. Please try again."));
    }
  }

  async function editSite(site: Site) {
    if (!onEdit) return;
    setError("");
    try {
      const { project } = await api<{ project: string }>(`/api/sites/${site.slug}/project`);
      onEdit(project);
    } catch {
      setError(t('Couldn\'t find the chat that built "{title}". It may have been deleted, or the site was published from another app.', { title: site.title }));
    }
  }

  async function showHistory(site: Site) {
    setOpen(site);
    setView("history");
    setVersions(null);
    setRestoring(null);
    setRestored(false);
    setError("");
    try {
      setVersions((await api<{ versions: Version[] }>(`/api/sites/${site.slug}/versions`)).versions);
    } catch {
      setError(t("Couldn't load the earlier versions. Please try again."));
    }
  }

  async function restore(id: string) {
    if (!open) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/sites/${open.slug}/versions`, { method: "POST", json: { id } });
      setVersions((await api<{ versions: Version[] }>(`/api/sites/${open.slug}/versions`)).versions);
      setRestored(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Couldn't bring that version back."));
    }
    setRestoring(null);
    setBusy(false);
  }

  async function showVisits(site: Site) {
    setOpen(site);
    setView("visits");
    setVisits(null);
    setError("");
    try {
      setVisits(await api<Visits>(`/api/sites/${site.slug}/visits`));
    } catch {
      setError(t("Couldn't load the visitor stats. Please try again."));
    }
  }

  async function markOrder(order: Order) {
    if (!open) return;
    const done = !order.done;
    setShop((s) => s && { ...s, orders: s.orders.map((o) => (o.id === order.id ? { ...o, done } : o)) });
    try {
      await api(`/api/sites/${open.slug}/orders`, { method: "PATCH", json: { id: order.id, done } });
    } catch {
      setShop((s) => s && { ...s, orders: s.orders.map((o) => (o.id === order.id ? { ...o, done: order.done } : o)) });
      setError(t("Couldn't update that order. Please try again."));
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
      setError(t("Couldn't load the messages. Please try again."));
      setMessages([]);
    }
  }

  async function showMembers(site: Site) {
    setOpen(site);
    setView("members");
    setMembers(null);
    setError("");
    try {
      setMembers((await api<{ members: Member[] }>(`/api/sites/${site.slug}/members`)).members);
    } catch {
      setError(t("Couldn't load the members. Please try again."));
      setMembers([]);
    }
  }

  async function showAi(site: Site) {
    setOpen(site);
    setView("ai");
    setAi(null);
    setError("");
    try {
      setAi(await api<Ai>(`/api/sites/${site.slug}/ai`));
    } catch {
      setError(t("Couldn't load the AI settings. Please try again."));
    }
  }

  async function saveAi(change: Partial<Ai>) {
    if (!open || !ai) return;
    const before = ai;
    setAi({ ...ai, ...change });
    try {
      setAi(await api<Ai>(`/api/sites/${open.slug}/ai`, { method: "PATCH", json: change }));
    } catch {
      setAi(before);
      setError(t("Couldn't save that. Please try again."));
    }
  }

  async function showFiles(site: Site) {
    setOpen(site);
    setView("files");
    setUploads(null);
    setError("");
    try {
      setUploads(await api<Uploads>(`/api/sites/${site.slug}/files`));
    } catch {
      setError(t("Couldn't load this app's files. Please try again."));
    }
  }

  /** Lets the app take files from the people using it, or stops it. */
  async function saveUploadsOn(enabled: boolean) {
    if (!open || !uploads) return;
    const before = uploads;
    setUploads({ ...uploads, enabled });
    try {
      const saved = await api<{ enabled: boolean }>(`/api/sites/${open.slug}/files`, { method: "PATCH", json: { enabled } });
      setUploads((u) => (u ? { ...u, enabled: saved.enabled } : u));
    } catch {
      setUploads(before);
      setError(t("Couldn't save that. Please try again."));
    }
  }

  async function removeUpload(file: Upload) {
    if (!open || !uploads) return;
    try {
      await api(`/api/sites/${open.slug}/files?id=${encodeURIComponent(file.id)}`, { method: "DELETE" });
      setUploads({
        ...uploads,
        files: uploads.files.filter((f) => f.id !== file.id),
        use: { ...uploads.use, files: uploads.use.files - 1, bytes: uploads.use.bytes - file.size },
      });
    } catch {
      setError(t("Couldn't delete that file. Please try again."));
    }
  }

  async function removeMember(member: Member) {
    if (!open) return;
    try {
      await api(`/api/sites/${open.slug}/members?id=${encodeURIComponent(member.id)}`, { method: "DELETE" });
      setMembers((list) => list?.filter((m) => m.id !== member.id) ?? null);
      setSites((all) => all?.map((s) => (s.slug === open.slug ? { ...s, members: Math.max(0, s.members - 1) } : s)) ?? null);
    } catch {
      setError(t("Couldn't remove that member. Please try again."));
    }
  }

  async function deleteMessage(id: string) {
    if (!open) return;
    try {
      await api(`/api/sites/${open.slug}/inbox?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setMessages((list) => list?.filter((m) => m.id !== id) ?? null);
      setSites((all) => all?.map((s) => (s.slug === open.slug ? { ...s, messages: s.messages - 1 } : s)) ?? null);
    } catch {
      setError(t("Couldn't delete that message. Please try again."));
    }
  }

  async function unpublish(slug: string) {
    try {
      await api(`/api/sites?slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
      setSites((all) => all?.filter((s) => s.slug !== slug) ?? null);
    } catch {
      setError(t("Couldn't unpublish that. Please try again."));
    }
    setConfirming(null);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("My websites and apps")}
        className="flex h-full w-full max-w-3xl flex-col bg-zinc-950 text-zinc-100 sm:h-[80vh] sm:rounded-2xl sm:border sm:border-white/8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/6 px-5 py-4">
          {open && (
            <button onClick={() => setOpen(null)} className="text-sm text-zinc-400 hover:text-zinc-100" aria-label={t("Back to my apps")}>
              ←
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">
            {open ? (
              <>
                {t(VIEW_TITLES[view])} · {open.title}
              </>
            ) : (
              t("My websites and apps")
            )}
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
            aria-label={t("Close")}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}
          {open && view === "history" ? (
            versions === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  {t(
                    "Each time you update this site, the version it replaces is kept here (the last 10). Bring one back if an update went wrong. Its data, messages and orders stay as they are.",
                  )}
                </p>
                {restored && (
                  <p className="text-sm text-primary-soft">
                    ✓ {t("That version is live again.")}{" "}
                    <a href={`/p/${open.slug}`} target="_blank" rel="noreferrer" className="underline">
                      {t("Open the site")} ↗
                    </a>
                  </p>
                )}
                {versions.length === 0 ? (
                  <p className="text-sm text-zinc-500">{t("No earlier versions yet. They appear here after your next update.")}</p>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="text-zinc-100">{t("Published {date}", { date: dateLabel(v.createdAt, t.locale) })}</p>
                          <p className="truncate text-xs text-zinc-500">{v.title}</p>
                        </div>
                        {restoring === v.id ? (
                          <span className="flex items-center gap-3 text-xs">
                            <span className="text-zinc-400">{t("Put this version live?")}</span>
                            <button onClick={() => restore(v.id)} disabled={busy} className="text-primary-soft hover:text-white disabled:opacity-50">
                              {busy ? t("Bringing back…") : t("Yes, bring it back")}
                            </button>
                            <button onClick={() => setRestoring(null)} className="text-zinc-400 hover:text-zinc-100">
                              {t("Cancel")}
                            </button>
                          </span>
                        ) : (
                          <span className="flex items-center gap-3 text-xs">
                            <a href={`/api/sites/${open.slug}/versions?view=${v.id}`} target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-white">
                              {t("View")} ↗
                            </a>
                            <button onClick={() => setRestoring(v.id)} className="rounded-md border border-primary/40 px-2 py-0.5 text-primary-soft hover:bg-primary/10">
                              {t("Bring back")}
                            </button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          ) : open && view === "files" ? (
            uploads === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : (
              <div className="space-y-4">
                <label className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
                  <input
                    type="checkbox"
                    checked={uploads.enabled}
                    onChange={(e) => saveUploadsOn(e.target.checked)}
                    className="h-4 w-4 accent-emerald-500"
                  />
                  <span className="flex-1">
                    <span className="block text-zinc-100">{t("Let people send files to this app")}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      {t("Photos, PDFs and text files up to 5 MB. Anyone with a file's link can open it.")}
                    </span>
                  </span>
                  <span className="text-xs text-zinc-500">{uploads.enabled ? t("On") : t("Off")}</span>
                </label>
                {uploads.files.length === 0 ? (
                  <p className="mx-auto mt-12 max-w-sm text-center text-sm text-zinc-500">
                    {t("No files yet. When your app lets people send a photo, a PDF or a document, what they send shows up here.")}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    <li className="text-xs text-zinc-500">
                      {uploads.use.files === 1
                        ? t("1 file, {used} of {limit} used.", { used: sizeLabel(uploads.use.bytes, t), limit: sizeLabel(uploads.use.maxBytes, t) })
                        : t("{count} files, {used} of {limit} used.", {
                            count: uploads.use.files,
                            used: sizeLabel(uploads.use.bytes, t),
                            limit: sizeLabel(uploads.use.maxBytes, t),
                          })}
                    </li>
                    {uploads.files.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
                        <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-primary-soft hover:underline">
                          {f.name}
                        </a>
                        <span className="text-xs text-zinc-500">{sizeLabel(f.size, t)}</span>
                        <span className="text-xs text-zinc-500">{dateLabel(f.createdAt, t.locale)}</span>
                        <button onClick={() => removeUpload(f)} className="text-xs text-zinc-500 hover:text-red-400" aria-label={t("Delete {name}", { name: f.name })}>
                          🗑
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          ) : open && view === "ai" ? (
            ai === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : (
              <div className="space-y-5">
                <p className="text-sm text-zinc-400">
                  {t(
                    "Apps you build can answer questions, write and sort things out with AI. You pay for it with your Flash credits, so it stays off until you turn it on, and it never spends more in a day than you allow here.",
                  )}
                </p>
                <label className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
                  <input
                    type="checkbox"
                    checked={ai.enabled}
                    onChange={(e) => saveAi({ enabled: e.target.checked })}
                    className="h-4 w-4 accent-emerald-500"
                  />
                  <span className="flex-1 text-zinc-100">{t("Let this app use AI")}</span>
                  <span className="text-xs text-zinc-500">{ai.enabled ? t("On") : t("Off")}</span>
                </label>
                <label className="block rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
                  <span className="block text-zinc-100">{t("Credits it may use in a day")}</span>
                  <span className="mt-1 block text-xs text-zinc-500">
                    {t("About {count} answers a day. It stops until tomorrow when it reaches this.", {
                      count: Math.max(1, Math.floor(ai.dailyCredits / 2)),
                    })}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={5000}
                    step={10}
                    defaultValue={ai.dailyCredits}
                    onBlur={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isFinite(value) && value !== ai.dailyCredits) saveAi({ dailyCredits: value });
                    }}
                    className="mt-2 w-32 rounded-lg border border-white/10 bg-zinc-900 px-3 py-1.5 text-zinc-100 outline-none focus:border-primary/50"
                  />
                </label>
                <p className="text-sm text-zinc-400">
                  {ai.askedToday === 1
                    ? t("Today: 1 question, {used} of {limit} credits used.", {
                        used: ai.usedToday.toLocaleString(t.locale),
                        limit: ai.dailyCredits.toLocaleString(t.locale),
                      })
                    : t("Today: {count} questions, {used} of {limit} credits used.", {
                        count: ai.askedToday.toLocaleString(t.locale),
                        used: ai.usedToday.toLocaleString(t.locale),
                        limit: ai.dailyCredits.toLocaleString(t.locale),
                      })}
                </p>
                <p className="text-xs text-zinc-500">
                  {t(
                    "Anyone using your app can ask it, so keep the daily limit at what you're happy to spend. Ask Flash to “add an AI helper to this app” to put it in the app itself.",
                  )}
                </p>
              </div>
            )
          ) : open && view === "members" ? (
            members === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : members.length === 0 ? (
              <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">
                {t(
                  "Nobody has signed up to this app yet. Ask Flash to add sign-in to an app, and the people who join show up here. Each of them gets their own private data, which only they can see.",
                )}
              </p>
            ) : (
              <ul className="space-y-2">
                <li className="flex items-center gap-3 text-xs text-zinc-500">
                  <span className="flex-1">
                    {members.length === 1
                      ? t("1 person has signed up.")
                      : t("{count} people have signed up.", { count: members.length.toLocaleString(t.locale) })}
                  </span>
                  <a href={`/api/sites/${open.slug}/members?format=csv`} download className="text-primary-soft hover:underline">
                    ⬇ {t("Download all (CSV)")}
                  </a>
                </li>
                {members.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-zinc-100">{m.name || m.email}</p>
                      {m.name && <p className="truncate text-xs text-zinc-500">{m.email}</p>}
                    </div>
                    <span className="text-xs text-zinc-500">{t("Joined {date}", { date: dateLabel(m.createdAt, t.locale) })}</span>
                    <button onClick={() => removeMember(m)} className="text-xs text-zinc-500 hover:text-red-400" title={t("Remove this person and their private data")}>
                      {t("Remove")}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : open && view === "visits" ? (
            visits === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : (
              <VisitsView visits={visits} />
            )
          ) : open && view === "payments" ? (
            payments === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : !payments.available ? (
              <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">{t("Payments are coming soon.")}</p>
            ) : !payments.allowed ? (
              <p className="text-sm text-gold-soft">{t("Selling from your sites comes with a paid plan. Pick one under your credits to start.")}</p>
            ) : !payments.seller.ready ? (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  {t(
                    "Let visitors pay on this site with card, Apple Pay or Google Pay. The money goes straight to your own Stripe account; Flash keeps 2% of each sale and Stripe takes its usual card fee.",
                  )}
                </p>
                {payments.seller.connected ? (
                  <p className="text-sm text-gold-soft">
                    {t("Stripe still needs a few details before you can take payments. Finish the sign-up, then come back here.")}
                  </p>
                ) : (
                  <label className="block text-sm text-zinc-300">
                    {t.node("Your business is in {country}", {
                      country: (
                        <select
                          value={country}
                          onChange={(e) => setCountry(e.target.value)}
                          className="ml-1 h-9 rounded-lg border border-white/10 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-primary/70"
                        >
                          {SELLER_COUNTRIES.map(([code, name]) => (
                            <option key={code} value={code}>
                              {t(name)}
                            </option>
                          ))}
                        </select>
                      ),
                    })}
                  </label>
                )}
                <button
                  onClick={connectStripe}
                  disabled={busy}
                  className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? t("Opening Stripe…") : payments.seller.connected ? t("Finish Stripe sign-up") : t("Connect Stripe")}
                </button>
                <p className="text-xs text-zinc-500">
                  {t("Stripe asks for your name, address and bank account so it can send you the money. Already have Stripe? Sign in with it on the next page.")}
                </p>
              </div>
            ) : shop === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : (
              <div className="space-y-6">
                <p className="text-sm text-zinc-400">
                  {t(
                    "Set a price for each item this site sells. Buyers pay with Stripe and the money goes to your Stripe account (Flash keeps 2%). Ask Flash to add buy buttons to your site, then publish it again.",
                  )}
                </p>
                <section>
                  <h3 className="mb-2 text-sm font-medium text-zinc-200">{t("For sale")}</h3>
                  {shop.products.length === 0 ? (
                    <p className="text-sm text-zinc-500">{t("Nothing priced yet.")}</p>
                  ) : (
                    <ul className="divide-y divide-white/6 rounded-xl border border-white/8">
                      {shop.products.map((p) => (
                        <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                          <span className="min-w-0 flex-1 truncate text-zinc-100">{p.name}</span>
                          {p.delivery && <span className="text-xs text-zinc-500">🚚 {t("delivery")}</span>}
                          <span className="tabular-nums text-zinc-200">{p.label}</span>
                          <button
                            onClick={() => setItem({ name: p.name, price: "", delivery: p.delivery })}
                            className="text-xs text-zinc-400 hover:text-white"
                          >
                            {t("Change")}
                          </button>
                          <button onClick={() => removeItem(p)} className="text-xs text-zinc-500 hover:text-red-400">
                            {t("Remove")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {shop.unpriced.length > 0 && (
                    <div className="mt-3 text-sm">
                      <p className="mb-1.5 text-xs text-gold-soft">{t("Your site has buy buttons for these, but they have no price yet:")}</p>
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
                      placeholder={t("Item name, as on your site")}
                      aria-label={t("Item name")}
                      className="h-10 min-w-0 flex-[2_1_12rem] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
                    />
                    <input
                      value={item.price}
                      onChange={(e) => setItem({ ...item, price: e.target.value })}
                      placeholder={t("Price ({currency})", { currency: payments.seller.currency.toUpperCase() })}
                      aria-label={t("Price")}
                      inputMode="decimal"
                      className="h-10 w-32 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <input type="checkbox" checked={item.delivery} onChange={(e) => setItem({ ...item, delivery: e.target.checked })} />
                      {t("Ask for a delivery address")}
                    </label>
                    <button
                      disabled={busy || !item.name.trim() || !item.price.trim()}
                      className="h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
                    >
                      {t("Save")}
                    </button>
                  </form>
                </section>
                <section>
                  <div className="mb-2 flex items-center gap-3">
                    <h3 className="text-sm font-medium text-zinc-200">
                      {t("Orders")}
                      {shop.orders.some((o) => !o.done) && (
                        <span className="ml-2 text-xs font-normal text-gold-soft">
                          {t("{count} to handle", { count: shop.orders.filter((o) => !o.done).length })}
                        </span>
                      )}
                    </h3>
                    {shop.orders.length > 0 && (
                      <a href={`/api/sites/${open.slug}/orders`} download className="ml-auto text-xs text-primary-soft hover:underline">
                        ⬇ {t("Download (CSV)")}
                      </a>
                    )}
                  </div>
                  {shop.orders.length === 0 ? (
                    <p className="text-sm text-zinc-500">{t("No orders yet. You get an email for each one.")}</p>
                  ) : (
                    <ul className="space-y-2">
                      {shop.orders.map((o) => (
                        <li key={o.id} className={`rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm ${o.done ? "opacity-60" : ""}`}>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className={o.done ? "text-zinc-400 line-through" : "text-zinc-100"}>
                              {o.quantity} × {o.item}
                            </span>
                            <span className="tabular-nums text-primary-soft">{o.total}</span>
                            <span className="ml-auto text-xs text-zinc-500">{dateLabel(o.createdAt, t.locale)}</span>
                            <button
                              onClick={() => markOrder(o)}
                              className={`rounded-md border px-2 py-0.5 text-xs ${o.done ? "border-white/10 text-zinc-400 hover:text-zinc-100" : "border-primary/40 text-primary-soft hover:bg-primary/10"}`}
                              title={o.done ? t("Mark as not handled yet") : t("Mark as sent or picked up")}
                            >
                              {o.done ? <>✓ {t("Done")}</> : t("Mark done")}
                            </button>
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
                    {t("Refunds and payouts are in your Stripe dashboard")} ↗
                  </a>
                </section>
              </div>
            )
          ) : open && view === "domains" ? (
            domains === null ? (
              !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : !domains.available ? (
              <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">{t("Custom domains are coming soon.")}</p>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  {t(
                    "Show this site on your own address, like yourbakery.com. Buy the domain anywhere (GoDaddy, Namecheap…), connect it here, then add the record Flash shows at your domain provider. It can take up to a few hours to start working.",
                  )}
                </p>
                {domains.domains.map((d) => (
                  <div key={d.domain} className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="font-medium text-zinc-100 hover:underline">
                        {d.domain}
                      </a>
                      <span className={`text-xs ${d.connected ? "text-primary-soft" : "text-gold-soft"}`}>
                        {d.connected ? <>✓ {t("Connected")}</> : t("Waiting for the DNS record")}
                      </span>
                      <span className="ml-auto flex gap-3 text-xs">
                        {!d.connected && (
                          <button onClick={() => showDomains(open)} className="text-zinc-300 hover:text-white">
                            {t("Check again")}
                          </button>
                        )}
                        <button onClick={() => disconnectDomain(d.domain)} className="text-zinc-500 hover:text-red-400">
                          {t("Remove")}
                        </button>
                      </span>
                    </div>
                    {!d.connected && d.records.length > 0 && (
                      <div className="mt-3 overflow-x-auto">
                        <p className="mb-2 text-xs text-zinc-400">{t("At your domain provider, open the DNS settings and add:")}</p>
                        <table className="w-full text-left text-xs">
                          <thead className="text-zinc-500">
                            <tr>
                              <th className="py-1 pr-4 font-normal">{t("Type")}</th>
                              <th className="py-1 pr-4 font-normal">{t("Name")}</th>
                              <th className="py-1 font-normal">{t("Value")}</th>
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
                        <p className="mt-2 text-xs text-zinc-500">{t("If a record with the same type and name is already there, edit it instead.")}</p>
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
                      aria-label={t("Domain")}
                      className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
                    />
                    <button
                      disabled={adding || !newDomain.trim()}
                      className="h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
                    >
                      {adding ? t("Connecting…") : t("Connect")}
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-gold-soft">{t("Custom domains come with a paid plan. Pick one under your credits to connect a domain.")}</p>
                )}
                {domains.allowed && domains.domains.length > 0 && !domains.domains.some((d) => d.domain.startsWith("www.")) && (
                  <p className="text-xs text-zinc-500">{t("Tip: connect the www. version too, so both addresses work.")}</p>
                )}
              </div>
            )
          ) : open ? (
            messages === null ? (
              <p className="text-sm text-zinc-500">{t("Loading…")}</p>
            ) : messages.length === 0 ? (
              <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">
                {t("No messages yet. When visitors send a contact or booking form on this site, it shows up here and you get an email.")}
              </p>
            ) : (
              <ul className="space-y-3">
                <li className="flex justify-end">
                  <a href={`/api/sites/${open.slug}/inbox?format=csv`} download className="text-xs text-primary-soft hover:underline">
                    ⬇ {t("Download all (CSV)")}
                  </a>
                </li>
                {messages.map((m) => (
                  <li key={m.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
                    <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                      <span className="rounded-full border border-white/10 px-2 py-0.5 text-zinc-300">{m.form}</span>
                      {!m.read && <span className="text-primary-soft">{t("New")}</span>}
                      <span className="ml-auto">{dateLabel(m.createdAt, t.locale)}</span>
                      <button onClick={() => deleteMessage(m.id)} className="hover:text-red-400" aria-label={t("Delete message")}>
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
            <p className="text-sm text-zinc-500">{t("Loading…")}</p>
          ) : sites.length === 0 ? (
            <div className="mx-auto mt-16 max-w-sm text-center">
              <p className="text-zinc-300">{t("Nothing published yet.")}</p>
              <p className="mt-1 text-sm text-zinc-500">
                {t(
                  "Ask Flash to build a website or app, then press Publish under the preview. It shows up here with its link and any messages visitors send.",
                )}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {sites.map((s) => (
                <li key={s.slug} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
                  <div className="min-w-0 flex-[1_1_14rem]">
                    <p className="truncate font-medium text-zinc-100">{s.title}</p>
                    <a href={`/p/${s.slug}`} target="_blank" rel="noreferrer" className="block truncate text-xs text-primary-soft hover:underline">
                      {typeof window !== "undefined" ? window.location.host : ""}/p/{s.slug}
                    </a>
                  </div>
                  {confirming === s.slug ? (
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-zinc-400">{t("Take it offline, with its data and messages?")}</span>
                      <button onClick={() => unpublish(s.slug)} className="text-red-400 hover:text-red-300">
                        {t("Unpublish")}
                      </button>
                      <button onClick={() => setConfirming(null)} className="text-zinc-400 hover:text-zinc-100">
                        {t("Keep")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      {onEdit && (
                        <button onClick={() => editSite(s)} className="text-zinc-200 hover:text-white" title={t("Open the chat that built this site")}>
                          ✏️ {t("Edit")}
                        </button>
                      )}
                      <button onClick={() => showMessages(s)} className="text-zinc-200 hover:text-white">
                        ✉️ {t("Messages")}
                        {s.messages ? <> ({s.messages})</> : null}
                        {s.unread > 0 && (
                          <span className="ml-1.5 rounded-full bg-brand px-1.5 py-0.5 text-[10px] text-on-brand">{t("{count} new", { count: s.unread })}</span>
                        )}
                      </button>
                      <button onClick={() => showVisits(s)} className="text-zinc-200 hover:text-white" title={t("Visits in the last 30 days")}>
                        📈 {t("Visitors")}
                        {s.views ? <> ({s.views.toLocaleString(t.locale)})</> : null}
                      </button>
                      <button onClick={() => showFiles(s)} className="text-zinc-200 hover:text-white" title={t("Files people sent to this app")}>
                        📁 {t("Files")}
                      </button>
                      <button onClick={() => showAi(s)} className="text-zinc-200 hover:text-white" title={t("Let this app use AI, and set what it may spend")}>
                        🤖 {t("AI")}
                      </button>
                      <button onClick={() => showMembers(s)} className="text-zinc-200 hover:text-white" title={t("People signed up to this app")}>
                        👤 {t("Members")}
                        {s.members ? <> ({s.members.toLocaleString(t.locale)})</> : null}
                      </button>
                      <button onClick={() => showDomains(s)} className="text-zinc-200 hover:text-white">
                        🔗 {t("Domain")}
                      </button>
                      <button onClick={() => showPayments(s)} className="text-zinc-200 hover:text-white">
                        💳 {t("Payments")}
                      </button>
                      <button onClick={() => showHistory(s)} className="text-zinc-200 hover:text-white" title={t("Earlier versions of this site")}>
                        🕘 {t("History")}
                      </button>
                      <button onClick={() => setConfirming(s.slug)} className="text-zinc-500 hover:text-red-400">
                        {t("Unpublish")}
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
  const t = useT();
  if (visits.views === 0) {
    return (
      <p className="mx-auto mt-16 max-w-sm text-center text-sm text-zinc-500">
        {t("No visitors yet. Share your site's link and each visit shows up here. Your own visits while signed in to Flash aren't counted.")}
      </p>
    );
  }
  const top = Math.max(...visits.days.map((d) => d.views));
  const today = visits.days[visits.days.length - 1];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            [msg("Visits"), visits.views],
            [msg("Visitors"), visits.visitors],
            [msg("Today"), today.views],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
            <p className="text-xs text-zinc-500">{t(label)}</p>
            <p className="mt-1 text-2xl font-medium tabular-nums text-zinc-100">{n.toLocaleString(t.locale)}</p>
          </div>
        ))}
      </div>
      <div>
        <p className="mb-2 text-xs text-zinc-500">{t("Visits per day, last 30 days")}</p>
        <div className="flex h-32 items-end gap-[3px]" role="img" aria-label={t("{count} visits in the last 30 days", { count: visits.views })}>
          {visits.days.map((d) => (
            <div
              key={d.day}
              title={t("{date}: {views} visits, {visitors} visitors", { date: dayLabel(d.day, t.locale), views: d.views, visitors: d.visitors })}
              className="min-w-0 flex-1 rounded-t-sm bg-primary/70 hover:bg-primary"
              style={{ height: d.views ? `${Math.max(4, (d.views / top) * 100)}%` : "2px", opacity: d.views ? 1 : 0.25 }}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
          <span>{dayLabel(visits.days[0].day, t.locale)}</span>
          <span>{t("Today")}</span>
        </div>
      </div>
      <div>
        <p className="mb-2 text-xs text-zinc-500">{t("Where visitors came from")}</p>
        <ul className="divide-y divide-white/6 rounded-xl border border-white/8">
          {visits.sources.map((s) => (
            <li key={s.source} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="min-w-0 truncate text-zinc-200">{s.source || t("Direct (typed, bookmarked or shared in a message)")}</span>
              <span className="tabular-nums text-zinc-400">{s.views.toLocaleString(t.locale)}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-zinc-500">
        {t("Counted without cookies. Visitors are people counted once a day; robots and your own visits are left out.")}
      </p>
    </div>
  );
}
