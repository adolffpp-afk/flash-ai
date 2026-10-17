"use client";

import { LogoMark } from "@/app/brand";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/store";
import { setPin } from "@/lib/account-pin";
import { useBrowserLanguage, useT } from "@/lib/use-t";

/** Asks for the code from the authenticator app (or a recovery code) to finish signing in. */
export function TwoFactorForm() {
  const t = useT();
  useBrowserLanguage();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { next, account } = await api<{ next?: string; account?: string }>("/api/auth/two-factor", {
        method: "POST",
        json: { code },
      });
      // This tab shows the account it just signed in to (others in this browser stay signed in).
      if (account) setPin(account);
      window.location.assign(next || "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Something went wrong."));
      if ((err as { code?: string }).code === "expired") setExpired(true);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-[var(--glass-shadow)]"
      >
        <LogoMark size={44} className="mb-4" />
        <h1 className="text-xl font-semibold">{t("Two-step sign-in")}</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {recovery
            ? t(
                "Type one of the recovery codes you saved when you turned on two-step sign-in. Each works once.",
              )
            : t(
                "Open your authenticator app and type the 6-digit code for Flash AI.",
              )}
        </p>
        <input
          className="mt-5 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-center text-lg tracking-[0.3em] outline-none transition focus:border-primary"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          aria-label={recovery ? t("Recovery code") : t("6-digit code")}
          placeholder={recovery ? "abcd-efgh" : "123456"}
          maxLength={recovery ? 12 : 7}
          autoFocus
          required
          disabled={expired}
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {t(error)}
          </p>
        )}
        {expired ? (
          <Link
            href="/"
            className="mt-5 block w-full rounded-xl bg-brand py-2.5 text-center font-medium text-on-brand transition hover:brightness-110"
          >
            {t("Sign in again")}
          </Link>
        ) : (
          <button
            disabled={busy || !code.trim()}
            className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? t("One moment…") : t("Sign in")}
          </button>
        )}
        {!expired && (
          <button
            type="button"
            onClick={() => {
              setRecovery(!recovery);
              setCode("");
              setError("");
            }}
            className="mt-4 block w-full text-center text-sm text-zinc-400 hover:text-zinc-100"
          >
            {recovery
              ? t("Use a code from the app instead")
              : t("Lost your phone? Use a recovery code")}
          </button>
        )}
      </form>
    </div>
  );
}
