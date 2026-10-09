"use client";

import { LogoMark } from "@/app/brand";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/store";

/**
 * The page an emailed sign-in link opens. Signing in waits for a click, because some email
 * scanners open links on their own and the link only works once.
 */
export function SignInLink({ token }: { token: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { next } = await api<{ next?: string }>("/api/auth/email-link", { method: "POST", json: { token } });
      window.location.assign(next || "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-[var(--glass-shadow)]">
        <LogoMark size={44} className="mb-4" />
        <h1 className="text-xl font-semibold">Sign in to Flash AI</h1>
        {token ? (
          <>
            <p className="mt-1 text-sm text-zinc-400">You&apos;re one click away.</p>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                {error}
              </p>
            )}
            <button
              disabled={busy}
              autoFocus
              className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "One moment…" : "Sign in"}
            </button>
          </>
        ) : (
          <p className="mt-4 text-sm text-red-400">This link is missing its code. Open the link from your email again.</p>
        )}
        <Link href="/" className="mt-4 block text-center text-sm text-zinc-400 hover:text-zinc-100">
          Back to Flash
        </Link>
      </form>
    </div>
  );
}
