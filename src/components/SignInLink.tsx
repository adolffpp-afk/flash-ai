"use client";

import { LogoMark, WithWordmark } from "@/app/brand";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/store";
import { useBrowserLanguage, useT } from "@/lib/use-t";

/**
 * The page an emailed sign-in link opens. Signing in waits for a click, because some email
 * scanners open links on their own and the link only works once.
 */
export function SignInLink({ token }: { token: string }) {
  const t = useT();
  useBrowserLanguage();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Opened in another browser than the one that asked for the link: the address it was sent to is typed first.
  const [askEmail, setAskEmail] = useState(false);
  const [email, setEmail] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { next, twoFactor } = await api<{ next?: string; twoFactor?: boolean }>("/api/auth/email-link", {
        method: "POST",
        json: { token, ...(askEmail && { email }) },
      });
      // Two-step sign-in is on: the code page finishes signing in, then goes on to next.
      window.location.assign(twoFactor ? "/signin/code" : next || "/");
    } catch (err) {
      if ((err as { code?: string }).code === "confirm_email") setAskEmail(true);
      setError(err instanceof Error ? err.message : t("Something went wrong."));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-[var(--glass-shadow)]">
        <LogoMark size={44} className="mb-4" />
        <h1 className="text-xl font-semibold"><WithWordmark text={t("Sign in to Flash ∞ AI")} /></h1>
        {token ? (
          <>
            <p className="mt-1 text-sm text-zinc-400">{t("You're one click away.")}</p>
            {askEmail && (
              <input
                className="mt-4 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 outline-none transition focus:border-primary"
                type="email"
                placeholder={t("Email")}
                aria-label={t("Email")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                autoFocus
              />
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-400">
                {t(error)}
              </p>
            )}
            <button
              disabled={busy}
              autoFocus
              className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? t("One moment…") : t("Sign in")}
            </button>
          </>
        ) : (
          <p className="mt-4 text-sm text-red-400">{t("This link is missing its code. Open the link from your email again.")}</p>
        )}
        <Link href="/" className="mt-4 block text-center text-sm text-zinc-400 hover:text-zinc-100">
          {t("Back to Flash")}
        </Link>
      </form>
    </div>
  );
}
