"use client";

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
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_60%)] px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-2xl shadow-black/40">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-pink-500 text-xl">⚡</div>
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
              className="mt-5 w-full rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 py-2.5 font-medium text-white transition hover:brightness-110 disabled:opacity-50"
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
