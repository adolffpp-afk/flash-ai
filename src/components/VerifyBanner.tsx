"use client";

import { useState } from "react";
import { api } from "@/lib/store";

/** Asks a new user to confirm their email, which unlocks the free monthly credits. */
export function VerifyBanner({ email, free }: { email: string; free: number }) {
  const [state, setState] = useState<{ busy?: boolean; message?: string; devLink?: string }>({});

  async function resend() {
    setState({ busy: true });
    try {
      const res = await api<{ devLink?: string }>("/api/auth/verify/send", { method: "POST" });
      setState({ message: `Sent. Check ${email}, including the spam folder.`, devLink: res.devLink });
    } catch (err) {
      setState({ message: err instanceof Error ? err.message : "Couldn't send the email." });
    }
  }

  return (
    <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex-1">
          Confirm your email to get your {free} free credits. We sent a link to <strong>{email}</strong>.
        </span>
        <button
          onClick={resend}
          disabled={state.busy}
          className="rounded-lg border border-indigo-400/40 px-3 py-1 text-xs hover:bg-indigo-500/20 disabled:opacity-50"
        >
          {state.busy ? "Sending…" : "Send again"}
        </button>
      </div>
      {state.message && <p className="mt-2 text-xs text-indigo-200">{state.message}</p>}
      {state.devLink && (
        <a href={state.devLink} className="mt-1 block text-xs text-emerald-300 underline">
          Demo mode: open the confirmation link
        </a>
      )}
    </div>
  );
}
