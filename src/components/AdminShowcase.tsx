"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import type { ShowcaseItem } from "@/lib/server/showcase.ts";
import type { ShowcaseStatus } from "@/lib/showcase";

/*
 * The dashboard's Showcase tab: the apps and pictures people offered for the "Made with Flash"
 * section at the foot of the landing page. Nothing shows there until it's approved here, and Hide
 * takes it off at once. Titles are shown as plain text. In English, like the rest of the dashboard.
 */

const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const STATUS: Record<ShowcaseStatus, [string, string]> = {
  waiting: ["Waiting", "bg-amber-400/15 text-amber-300"],
  shown: ["On the landing page", "bg-emerald-400/15 text-emerald-300"],
  hidden: ["Hidden", "bg-white/[0.06] text-zinc-400"],
};

function Card({ item, onChange }: { item: ShowcaseItem; onChange: (items: ShowcaseItem[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (status: ShowcaseStatus) => {
    setBusy(true);
    setError("");
    try {
      onChange((await api<{ items: ShowcaseItem[] }>("/api/admin/showcase", { method: "POST", json: { kind: item.kind, ref: item.ref, status } })).items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  // An offered picture isn't public until it's approved, so the dashboard reads it from its own address.
  const image = item.kind === "site" ? `/p/${item.ref}/card` : `/api/admin/showcase/picture?id=${encodeURIComponent(item.ref)}`;
  const [label, style] = STATUS[item.status];
  const button = "rounded-lg px-3 py-1.5 text-sm transition disabled:opacity-50";
  return (
    <section className={`flex flex-col overflow-hidden rounded-xl border ${item.status === "waiting" ? "border-amber-400/30" : "border-zinc-800"}`}>
      <div className="aspect-[1200/630] bg-zinc-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt="" loading="lazy" className="h-full w-full object-cover" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}>{label}</span>
          <span>{item.kind === "site" ? "App" : "Picture"}</span>
          <span>· {when(item.created_at)}</span>
        </div>
        <div className="truncate text-sm text-zinc-100" title={item.title}>
          {item.title}
        </div>
        <div className="truncate text-xs text-zinc-500">{item.email}</div>
        {item.kind === "site" && (
          <a href={`/p/${item.ref}`} target="_blank" rel="noreferrer" className="text-xs text-primary-soft hover:underline">
            Open the app ↗
          </a>
        )}
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {item.status !== "shown" && (
            <button disabled={busy} onClick={() => decide("shown")} className={`${button} bg-emerald-500/90 text-white hover:bg-emerald-500`}>
              Approve
            </button>
          )}
          {item.status !== "hidden" && (
            <button disabled={busy} onClick={() => decide("hidden")} className={`${button} border border-zinc-700 text-zinc-300 hover:bg-zinc-800`}>
              Hide
            </button>
          )}
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </section>
  );
}

export function AdminShowcase() {
  const [items, setItems] = useState<ShowcaseItem[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ items: ShowcaseItem[] }>("/api/admin/showcase")
      .then((r) => setItems(r.items))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!items) return <p className="text-sm text-zinc-500">Loading…</p>;
  const waiting = items.filter((i) => i.status === "waiting").length;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Apps and pictures people offered with “Show in Flash showcase”. Only approved ones appear in “Made with Flash” at the
        foot of the landing page, newest approved first; until there are enough, examples fill the rest. Your own show as soon
        as you offer them. {waiting ? `${waiting} waiting.` : ""}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing offered yet. Turn on “Show in Flash showcase” on an app (Link preview) or a picture (My creations).</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((i) => (
            <Card key={`${i.kind}:${i.ref}`} item={i} onChange={setItems} />
          ))}
        </div>
      )}
    </div>
  );
}
