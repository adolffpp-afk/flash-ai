"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { signInBody } from "@/lib/accounts";
import { LogoMark, Wordmark } from "@/app/brand";
import { msg } from "@/lib/i18n";
import { TAGLINE } from "@/lib/product";
import { useT } from "@/lib/use-t";
import { EmailLabel } from "./EmailLabel";
import { PasswordInput } from "./PasswordInput";

const FEATURES = [
  msg("🛠️ Build and publish apps"),
  msg("🖥️ Slides"),
  msg("✍️ Writing"),
  msg("🔎 Research with sources"),
  msg("💻 Code"),
  msg("🌍 Translation"),
  msg("📊 Docs & sheets"),
];

type ProviderId = "google" | "github" | "microsoft";

const PROVIDER_NAMES: Record<ProviderId, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };

function ProviderIcon({ id }: { id: ProviderId }) {
  if (id === "google") {
    return (
      <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0124 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 01-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
      </svg>
    );
  }
  if (id === "microsoft") {
    return (
      <svg viewBox="0 0 21 21" className="h-5 w-5" aria-hidden="true">
        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.7.5.5 5.7.5 12a11.5 11.5 0 007.9 10.9c.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.2-1.3-5.2-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 015.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.1v3.2c0 .3.2.7.8.6A11.5 11.5 0 0023.5 12C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  );
}

// Why a "Continue with …" sign-in came back without signing in (the auth_error in the address).
// Marked msg() so the tables have them; translated where shown.
const AUTH_ERRORS: Record<string, string> = {
  cancelled: msg("Sign-in was cancelled."),
  expired: msg("That sign-in took too long or started in another browser. Please try again."),
  unverified:
    msg("That account hasn't confirmed its email with the provider, so it can't open the Flash account with the same email. Sign in with your password or an email link instead."),
  no_email: msg("That account didn't share an email address. Try another way to sign in."),
  busy: msg("Too many attempts. Try again in 15 minutes."),
  unavailable: msg("That sign-in option isn't available right now."),
  failed: msg("Sign-in didn't work. Please try again."),
  verify_signin: msg("To confirm your email, sign in to that account, then open the link in the email again."),
  too_many_accounts: msg("You're signed in to 5 accounts on this browser. Log out of one first."),
};

export function AuthScreen({
  onDone,
  initialMode = "signup",
  initialError,
  onBack,
  next,
  adding,
}: {
  // Sign-up says when the confirmation email couldn't be sent; account is the one signed in to. The
  // form stays busy until it settles (saving what changed on the page under it, say).
  onDone: (result?: { emailFailed?: boolean; account?: string }) => void | Promise<void>;
  initialMode?: "signup" | "login";
  // An auth_error code from a "Continue with …" sign-in that didn't finish.
  initialError?: string;
  onBack?: () => void;
  // Where to return after a "Continue with …" or email-link sign-in (a path on this site).
  next?: string;
  // Adding another account while signed in to this one (email), which Back returns to; with no
  // email, Back returns to the account chooser. again: signing in again to the account this tab
  // showed, whose email is filled in. leave: before this page goes elsewhere to finish signing in
  // (the two-step code page, a "Continue with …" sign-in), Flash saves what changed under it, or
  // asks, as before a switch, and goes on (go) only once that's settled.
  adding?: { email?: string; again?: string; onBack: () => void; leave?: (go: () => void) => void | Promise<void> };
}) {
  const t = useT();
  const router = useRouter();
  const [mode, setMode] = useState<"signup" | "login" | "forgot" | "link">(initialMode);
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(adding?.again ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError ? (AUTH_ERRORS[initialError] ?? AUTH_ERRORS.failed) : "");
  const [busy, setBusy] = useState(false);
  // Which sign-in options the server has set up; their buttons appear once this loads.
  const [options, setOptions] = useState<{ providers: ProviderId[]; emailLink: boolean }>({ providers: [], emailLink: false });
  const form = useRef<HTMLFormElement>(null);
  const switched = useRef(false);

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then(setOptions)
      .catch(() => {});
  }, []);

  function switchMode(next: typeof mode) {
    switched.current = true;
    setMode(next);
    setError("");
    setSent(null);
  }

  // The button chosen ("Email me a sign-in link", "Forgot password?") is gone with the form it was
  // in: the focus moves to the new form's first field, not to the page under it.
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    if (!document.activeElement || document.activeElement === document.body) form.current?.querySelector<HTMLElement>("input")?.focus();
  }, [mode]);

  /** Off this page to finish signing in: while adding another account, once Flash has saved what changed under it, or asked. */
  async function leave(go: () => void) {
    if (adding?.leave) await adding.leave(go);
    else go();
  }

  /** A link that leaves this page (a "Continue with …" sign-in), while adding another account: through leave. */
  function leaveBy(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!adding?.leave || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (busy) return;
    const href = e.currentTarget.href;
    setBusy(true);
    void leave(() => window.location.assign(href)).finally(() => setBusy(false));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot" || mode === "link") {
        setSent(
          await api<{ devLink?: string }>(mode === "link" ? "/api/auth/email-link/request" : "/api/auth/reset/request", {
            method: "POST",
            json: { email, next },
          }),
        );
        return;
      }
      const result = await api<{ emailFailed?: boolean; twoFactor?: boolean; account?: string }>(`/api/auth/${mode}`, {
        method: "POST",
        // next: where the code page goes once signed in, when two-step sign-in is on.
        json: signInBody(mode, { name, email, password, next }),
      });
      // Two-step sign-in is on: the code page finishes signing in, then opens next.
      if (result.twoFactor) {
        await leave(() => router.push("/signin/code"));
        return;
      }
      await onDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  const input =
    "h-10 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm outline-none transition placeholder:text-zinc-500 focus:border-primary/70 focus:bg-white/[0.05]";
  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.12),transparent_60%)] px-4 py-12">
      <div className="grid w-full max-w-4xl items-center gap-12 md:grid-cols-2 md:gap-16">
        {/* min-w-0: a long email in Back shortens rather than widening the page past a phone's screen. */}
        <div className="min-w-0">
          {adding ? (
            <button
              onClick={adding.onBack}
              className="mb-4 -ms-2 inline-flex min-h-11 max-w-full items-center gap-1 rounded-lg px-2 text-sm text-zinc-400 hover:text-zinc-100"
            >
              <span aria-hidden className="rtl:-scale-x-100">←</span>
              {adding.email ? <EmailLabel text={msg("Back to {email}")} email={adding.email} /> : t("Back")}
            </button>
          ) : (
            onBack && (
              <button
                onClick={onBack}
                className="mb-6 text-sm text-zinc-400 hover:text-zinc-100"
              >
                ← {t("Back to home")}
              </button>
            )
          )}
          <LogoMark size={56} className="mb-6" />
          <h1 className="text-3xl font-semibold tracking-[-0.03em] text-white">
            <Wordmark tm />
          </h1>
          <p className="mt-3 max-w-sm leading-relaxed text-zinc-400">{t(TAGLINE)}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {FEATURES.map((f) => (
              <span
                key={f}
                className="rounded-full border border-white/8 px-3 py-1 text-xs text-zinc-400"
              >
                {t(f)}
              </span>
            ))}
          </div>
        </div>
        <form
          ref={form}
          onSubmit={submit}
          className="rounded-2xl border border-white/8 bg-zinc-950/70 p-6 backdrop-blur sm:p-8"
        >
          <h2 className="text-lg font-medium tracking-tight">
            {adding && !adding.again && (mode === "signup" || mode === "login")
              ? t("Add another account")
              : mode === "signup"
              ? t("Create your account")
              : mode === "login"
                ? t("Welcome back")
                : mode === "link"
                  ? t("Email me a sign-in link")
                  : t("Reset your password")}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            {mode === "signup"
              ? t("Free credits every month. No card needed.")
              : mode === "login"
                ? t("Sign in to pick up where you left off.")
                : mode === "link"
                  ? t("We'll email you a link that signs you in, no password needed. It works once, for 15 minutes.")
                  : t("Enter your email and we'll send you a link to choose a new password.")}
          </p>
          {(mode === "signup" || mode === "login") && (options.providers.length > 0 || options.emailLink) && (
            <div className="mt-5 space-y-2">
              {options.providers.map((id) => (
                <a
                  key={id}
                  href={`/api/auth/oauth/${id}${next ? `?next=${encodeURIComponent(next)}` : ""}`}
                  onClick={leaveBy}
                  aria-label={t("Continue with {provider}", { provider: PROVIDER_NAMES[id] })}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] text-sm text-zinc-200 transition hover:border-white/15 hover:bg-white/[0.06]"
                >
                  <ProviderIcon id={id} />
                  {t("Continue with {provider}", { provider: PROVIDER_NAMES[id] })}
                </a>
              ))}
              {options.providers.length > 0 && <OrDivider />}
              {options.emailLink && (
                <button
                  type="button"
                  onClick={() => switchMode("link")}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] text-sm text-zinc-200 transition hover:border-white/15 hover:bg-white/[0.06]"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M3 7l9 6 9-6" />
                  </svg>
                  {t("Email me a sign-in link")}
                </button>
              )}
              {!options.providers.length && <OrDivider />}
            </div>
          )}
          <div className="mt-6 space-y-3">
            {mode === "signup" && (
              <input
                className={input}
                placeholder={t("Your name")}
                aria-label={t("Your name")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            )}
            <input
              className={input}
              type="email"
              placeholder={t("Email")}
              aria-label={t("Email")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            {(mode === "signup" || mode === "login") && (
              <PasswordInput
                className={input}
                placeholder={mode === "signup" ? t("Password (8+ characters)") : t("Password")}
                aria-label={t("Password")}
                value={password}
                onValue={setPassword}
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                required
                minLength={mode === "signup" ? 8 : undefined}
                suggest={mode === "signup"}
              />
            )}
          </div>
          {mode === "login" && (
            <button
              type="button"
              onClick={() => switchMode("forgot")}
              className="mt-2 text-xs text-zinc-400 hover:text-zinc-100"
            >
              {t("Forgot password?")}
            </button>
          )}
          {(mode === "forgot" || mode === "link") && sent && (
            <div
              role="status"
              className="mt-3 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200"
            >
              {mode === "link"
                ? t("Your sign-in link is on its way. Check your inbox and spam folder.")
                : t("If an account uses that email, a reset link is on its way. Check your inbox and spam folder.")}
              {sent.devLink && (
                <a
                  href={sent.devLink}
                  onClick={leaveBy}
                  className="mt-1 block break-all text-xs text-emerald-300 underline"
                >
                  {mode === "link" ? t("Demo mode: open the sign-in link") : t("Demo mode: open the reset link")}
                </a>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {t(error)}
            </p>
          )}
          {mode === "signup" && (
            <p className="mt-3 text-xs text-zinc-500">
              {t.node("By creating an account you agree to the {terms} and {privacy}.", {
                terms: (
                  <a href="/terms" target="_blank" className="text-zinc-300 underline hover:text-white">
                    {t("Terms")}
                  </a>
                ),
                privacy: (
                  <a href="/privacy" target="_blank" className="text-zinc-300 underline hover:text-white">
                    {t("Privacy Policy")}
                  </a>
                ),
              })}
            </p>
          )}
          <button
            disabled={busy}
            className="mt-6 h-10 w-full rounded-lg bg-brand text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
          >
            {busy
              ? t("One moment…")
              : mode === "signup"
                ? t("Create account")
                : mode === "login"
                  ? t("Sign in")
                  : mode === "link"
                    ? t("Send sign-in link")
                    : t("Send reset link")}
          </button>
          <p className="mt-5 text-center text-sm text-zinc-400">
            {mode === "signup"
              ? t("Already have an account?")
              : mode === "login"
                ? t("New to Flash?")
                : mode === "link"
                  ? t("Prefer a password?")
                  : t("Remembered it?")}{" "}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => switchMode(mode === "login" ? "signup" : "login")}
            >
              {mode === "login" ? t("Create an account") : t("Sign in")}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}

function OrDivider() {
  const t = useT();
  return (
    <div role="separator" aria-label={t("or")} className="flex items-center gap-3 py-1 text-xs text-zinc-500">
      <span className="h-px flex-1 bg-white/8" />
      {t("or")}
      <span className="h-px flex-1 bg-white/8" />
    </div>
  );
}
