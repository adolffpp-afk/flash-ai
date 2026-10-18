"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/store";
import { announce, setPin } from "@/lib/account-pin";
import { LogoMark } from "@/app/brand";
import { useBrowserLanguage, useT } from "@/lib/use-t";

/** The page a password reset link opens: choose a new password, then go to the app signed in. */
export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const t = useT();
  useBrowserLanguage();
  const [password, setPassword] = useState("");
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
      const { twoFactor, account } = await api<{ twoFactor?: boolean; account?: string }>("/api/auth/reset", { method: "POST", json: { token, password, ...(askEmail && { email }) } });
      if (account) setPin(account);
      // Two-step sign-in is on: a reset link alone doesn't sign in; the code page does.
      if (twoFactor) router.push("/signin/code");
      else {
        // Signed in: Flash's other tabs signed out here open the account too (the code page tells them itself).
        announce({ type: "changed" });
        router.push("/?reset=1");
      }
    } catch (err) {
      if ((err as { code?: string }).code === "confirm_email") setAskEmail(true);
      setError(err instanceof Error ? err.message : t("Something went wrong."));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_60%)] px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-[var(--glass-shadow)]">
        <LogoMark size={44} className="mb-4" />
        <h1 className="text-xl font-semibold">{t("Choose a new password")}</h1>
        <p className="mt-1 text-sm text-zinc-400">{t("You'll be signed out on your other devices.")}</p>
        {token ? (
          <>
            {askEmail && (
              <input
                className="mt-5 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 outline-none transition focus:border-primary"
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
            <input
              className="mt-5 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 outline-none transition focus:border-primary"
              type="password"
              placeholder={t("New password (8+ characters)")}
              aria-label={t("New password (8+ characters)")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              autoFocus
            />
            {error && <p className="mt-3 text-sm text-red-400">{t(error)}</p>}
            <button
              disabled={busy}
              className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? t("One moment…") : t("Save and sign in")}
            </button>
          </>
        ) : (
          <p className="mt-4 text-sm text-red-400">{t("This link is missing its code. Open the link from your email again.")}</p>
        )}
      </form>
    </div>
  );
}
