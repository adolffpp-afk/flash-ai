"use client";

import { useState } from "react";
import { api } from "@/lib/store";
import { REPORT_KIND_NAMES, reasonLabel } from "@/lib/report";
import type { ReportedItem } from "@/lib/server/reports.ts";

/*
 * The dashboard's Reports tab: what people reported from shared chats and the Report content page
 * (/report), one card per reported item, items with open reports first. Everything a reporter typed
 * is shown as plain text, never as HTML. In English, like the rest of the dashboard.
 */

const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// What taking each kind down does, said before it happens.
const TAKE_DOWN_SAYS: Record<ReportedItem["kind"], string> = {
  share:
    "Turn off this share link? It stops working for everyone at once. The owner's chat isn't changed, and they could share it again.",
  site: "Unpublish this app? It goes offline at once with everything it kept: its data, members, form messages, orders, files and earlier versions, and its own domains are disconnected. This can't be undone. The chat the owner built it in isn't changed.",
  file: "Turn off this file link? It stops working for everyone at once (browsers that already opened it may keep it for up to a day). The owner's file stays in their account.",
};

function Status({ item }: { item: ReportedItem }) {
  const [label, style] =
    item.status === "open"
      ? [`${item.open} open`, "bg-amber-400/15 text-amber-300"]
      : item.status === "taken_down"
        ? ["Taken down", "bg-red-400/10 text-red-300"]
        : ["Reviewed", "bg-white/[0.06] text-zinc-400"];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}>{label}</span>;
}

function ReportCard({ item, onChange }: { item: ReportedItem; onChange: (items: ReportedItem[]) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const act = async (action: "reviewed" | "take_down") => {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ items: ReportedItem[] }>("/api/admin/reports", { method: "POST", json: { kind: item.kind, id: item.id, action } });
      setConfirming(false);
      onChange(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const button = "rounded-lg px-3 py-1.5 text-sm transition disabled:opacity-50";
  return (
    <section className={`rounded-xl border p-4 ${item.open ? "border-amber-400/30 bg-amber-400/[0.03]" : "border-zinc-800"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <Status item={item} />
            <span>{REPORT_KIND_NAMES[item.kind]}</span>
            <span>
              · {item.total} {item.total === 1 ? "report" : "reports"}
            </span>
          </div>
          <h3 className="mt-1.5 break-words text-sm font-medium text-zinc-100">{item.title || "Untitled"}</h3>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            {item.live ? (
              <a href={item.path} target="_blank" rel="noreferrer noopener" className="break-all text-primary-soft hover:underline">
                Open {item.path} ↗
              </a>
            ) : (
              <span className="break-all">{item.path} (no longer up)</span>
            )}
            {item.via && <span className="break-all">Reported at {item.via}</span>}
            <span className="break-all">Owner: {item.ownerEmail || "unknown (account deleted)"}</span>
          </div>
        </div>
        {(item.open > 0 || (item.canTakeDown && !confirming)) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {item.open > 0 && (
              <button disabled={busy} onClick={() => act("reviewed")} className={`${button} border border-white/10 text-zinc-200 hover:bg-white/[0.05]`}>
                Mark reviewed
              </button>
            )}
            {item.canTakeDown && !confirming && (
              <button disabled={busy} onClick={() => setConfirming(true)} className={`${button} border border-red-400/40 text-red-300 hover:bg-red-400/10`}>
                Take down
              </button>
            )}
          </div>
        )}
      </div>

      {confirming && (
        <div role="alertdialog" aria-label="Take down" className="mt-3 rounded-lg border border-red-400/30 bg-red-400/[0.06] p-3 text-sm text-zinc-200">
          <p>{TAKE_DOWN_SAYS[item.kind]}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => act("take_down")} className={`${button} bg-red-500 font-medium text-white hover:brightness-110`}>
              {busy ? "Taking it down…" : "Yes, take it down"}
            </button>
            <button disabled={busy} onClick={() => setConfirming(false)} className={`${button} text-zinc-300 hover:bg-white/[0.05]`}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <ul className="mt-3 divide-y divide-zinc-800/70 border-t border-zinc-800/70">
        {item.reports.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-zinc-500">
              <span className="text-sm font-medium text-zinc-200">{reasonLabel(r.reason)}</span>
              <span>{when(r.createdAt)}</span>
              {r.repeats > 1 && <span>· sent {r.repeats} times from one network</span>}
              {r.email ? (
                <span className="break-all">
                  ·{" "}
                  <a href={`mailto:${r.email}`} className="text-primary-soft hover:underline">
                    {r.email}
                  </a>
                </span>
              ) : (
                <span>· no email given</span>
              )}
              {r.status !== "open" && <span>· {r.status === "taken_down" ? "taken down" : "reviewed"}</span>}
            </div>
            {r.details && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-300">{r.details}</p>}
          </li>
        ))}
      </ul>
      {item.last && (
        <p className="mt-1 text-xs text-zinc-500">
          {item.last.action === "taken_down" ? "Taken down" : "Marked reviewed"} by {item.last.by} · {when(item.last.at)}
        </p>
      )}
    </section>
  );
}

export function AdminReports({ items, error, onChange }: { items: ReportedItem[] | null; error: string; onChange: (items: ReportedItem[]) => void }) {
  if (error) return <p className="mt-10 text-sm text-red-400">{error}</p>;
  if (!items) return <p className="mt-10 text-zinc-500">Loading…</p>;
  const open = items.filter((i) => i.open > 0).length;
  return (
    <div className="mt-6 space-y-3">
      <p className="text-xs text-zinc-500">
        What people reported from shared chats and the public Report content page (/report). Several reports from one network for the
        same reason count once. Mark reviewed closes an item&apos;s open reports; Take down turns off a share link or a file link, or
        unpublishes an app as its owner would. You get an email for a new report at most once per item an hour, and for at most two
        of one network&apos;s reports a day.
      </p>
      {items.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 p-6 text-center text-sm text-zinc-500">No reports yet.</p>
      ) : (
        <>
          <p className="text-sm text-zinc-300">
            {open ? `${open} ${open === 1 ? "item needs" : "items need"} a look` : "Nothing open"} · {items.length} reported{" "}
            {items.length === 1 ? "item" : "items"}
          </p>
          {items.map((item) => (
            <ReportCard key={`${item.kind}:${item.id}`} item={item} onChange={onChange} />
          ))}
        </>
      )}
    </div>
  );
}
