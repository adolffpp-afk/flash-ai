"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";

type Site = { slug: string; title: string; updated_at: number; messages: number; unread: number };
type SiteMessage = { id: string; form: string; data: Record<string, unknown>; createdAt: number; read: boolean };

const dateLabel = (t: number) =>
  new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fieldText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** My websites and apps: every published app, its link, and the forms visitors sent to it. */
export function MyApps({ onClose }: { onClose: () => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [open, setOpen] = useState<Site | null>(null);
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

  async function showMessages(site: Site) {
    setOpen(site);
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
            {open ? `Messages · ${open.title}` : "My websites and apps"}
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
          {open ? (
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
                    <div className="flex items-center gap-3 text-xs">
                      <button onClick={() => showMessages(s)} className="text-zinc-200 hover:text-white">
                        ✉️ Messages{s.messages ? ` (${s.messages})` : ""}
                        {s.unread > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-white">{s.unread} new</span>}
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
