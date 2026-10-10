"use client";

import { useState } from "react";
import { api } from "@/lib/store";
import { useT } from "@/lib/use-t";

/** Asks a new user to confirm their email, which unlocks the free monthly credits. */
export function VerifyBanner({ email, free, failed = false }: { email: string; free: number; failed?: boolean }) {
  const t = useT();
  const [state, setState] = useState<{ busy?: boolean; message?: string; devLink?: string }>({});
  // Whether sign-up's email didn't go out, until a resend works.
  const [unsent, setUnsent] = useState(failed);

  async function resend() {
    setState({ busy: true });
    try {
      const res = await api<{ devLink?: string }>("/api/auth/verify/send", { method: "POST" });
      setState({ message: t("Sent. Check {email}, including the spam folder.", { email }), devLink: res.devLink });
      setUnsent(false);
    } catch (err) {
      setState({ message: err instanceof Error ? err.message : t("Couldn't send the email.") });
    }
  }

  return (
    <div role="status" className="rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm text-zinc-100">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex-1">
          {t("Confirm your email to get your {count} free credits.", { count: free.toLocaleString(t.locale) })}{" "}
          {unsent ? t("We couldn't send the email. Press Send again.") : t.node("We sent a link to {email}.", { email: <strong>{email}</strong> })}
        </span>
        <button
          onClick={resend}
          disabled={state.busy}
          className="rounded-lg border border-primary/50 px-3 py-1 text-xs hover:bg-primary/20 disabled:opacity-50"
        >
          {state.busy ? t("Sending…") : t("Send again")}
        </button>
      </div>
      {state.message && <p className="mt-2 text-xs text-primary-soft">{state.message}</p>}
      {state.devLink && (
        <a href={state.devLink} className="mt-1 block text-xs text-emerald-300 underline">
          {t("Demo mode: open the confirmation link")}
        </a>
      )}
    </div>
  );
}
