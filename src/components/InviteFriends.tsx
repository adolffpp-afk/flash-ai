"use client";

import { useEffect, useRef, useState } from "react";
import type { Me } from "@/lib/store";

const pct = (share: number) => `${Math.round(share * 100)}%`;
const dateLabel = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The referral link with a Copy button, the reward rule, and how it has gone so far. */
export function InviteFriends({ referral }: { referral: Me["referral"] }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(referral.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link is selectable in the box.
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 p-4">
      <p className="text-sm text-zinc-300">
        When a friend signs up with your link and makes their first purchase, they get {pct(referral.friendShare)} extra
        credits right away. You get {pct(referral.referrerShare)} of the credits they bought (up to{" "}
        {referral.referrerCap.toLocaleString("en-US")}), ready to use {referral.pendingDays} days after their payment
        unless it&apos;s refunded.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          readOnly
          value={referral.link}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Your invite link"
          className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
        />
        <button
          onClick={copy}
          className="h-9 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-3 text-xs text-zinc-400">
        {referral.joined} {referral.joined === 1 ? "friend" : "friends"} joined · {referral.rewarded}{" "}
        {referral.rewarded === 1 ? "reward" : "rewards"} earned · {referral.earned.toLocaleString("en-US")} bonus credits
      </p>
      {referral.pending.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {referral.pending.map((p, i) => (
            <li key={i} className="flex items-center gap-2 text-zinc-400">
              <span className="rounded-full bg-gold/15 px-2 py-0.5 font-medium text-gold light:text-gold-soft">
                +{p.credits.toLocaleString("en-US")}
              </span>
              pending, available on {dateLabel(p.availableAt)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Invite friends panel on its own, opened from the sidebar. */
export function InviteDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Runs once on open: focus starts on Close, and Escape closes the dialog.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Invite friends"
        className="w-full max-w-lg rounded-t-2xl border border-white/8 bg-zinc-950 p-6 sm:rounded-2xl sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-medium tracking-tight">Invite friends</h2>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label="Close">
            ✕
          </button>
        </div>
        <InviteFriends referral={me.referral} />
      </div>
    </div>
  );
}
