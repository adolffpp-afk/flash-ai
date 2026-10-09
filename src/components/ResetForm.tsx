"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/store";
import { LogoMark } from "@/app/brand";

/** The page a password reset link opens: choose a new password, then go to the app signed in. */
export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/reset", { method: "POST", json: { token, password } });
      router.push("/?reset=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_60%)] px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-[var(--glass-shadow)]">
        <LogoMark size={44} className="mb-4" />
        <h1 className="text-xl font-semibold">Choose a new password</h1>
        <p className="mt-1 text-sm text-zinc-400">You&apos;ll be signed out on your other devices.</p>
        {token ? (
          <>
            <input
              className="mt-5 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 outline-none transition focus:border-primary"
              type="password"
              placeholder="New password (8+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              autoFocus
            />
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <button
              disabled={busy}
              className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "One moment…" : "Save and sign in"}
            </button>
          </>
        ) : (
          <p className="mt-4 text-sm text-red-400">This link is missing its code. Open the link from your email again.</p>
        )}
      </form>
    </div>
  );
}
