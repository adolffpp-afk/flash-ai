"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import { LogoMark } from "@/app/brand";

const FEATURES = [
  "🛠️ Build and publish apps",
  "🖥️ Slides",
  "✍️ Writing",
  "🔎 Research with sources",
  "💻 Code",
  "🌍 Translation",
  "📊 Docs & sheets",
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
const AUTH_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "That sign-in took too long or started in another browser. Please try again.",
  unverified:
    "That account hasn't confirmed its email with the provider, so it can't open the Flash account with the same email. Sign in with your password or an email link instead.",
  no_email: "That account didn't share an email address. Try another way to sign in.",
  busy: "Too many attempts. Try again in 15 minutes.",
  unavailable: "That sign-in option isn't available right now.",
  failed: "Sign-in didn't work. Please try again.",
};

export function AuthScreen({
  onDone,
  initialMode = "signup",
  initialError,
  onBack,
}: {
  // Sign-up says when the confirmation email couldn't be sent.
  onDone: (result?: { emailFailed?: boolean }) => void;
  initialMode?: "signup" | "login";
  // An auth_error code from a "Continue with …" sign-in that didn't finish.
  initialError?: string;
  onBack?: () => void;
}) {
  const [mode, setMode] = useState<"signup" | "login" | "forgot" | "link">(initialMode);
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError ? (AUTH_ERRORS[initialError] ?? AUTH_ERRORS.failed) : "");
  const [busy, setBusy] = useState(false);
  // Which sign-in options the server has set up; their buttons appear once this loads.
  const [options, setOptions] = useState<{ providers: ProviderId[]; emailLink: boolean }>({ providers: [], emailLink: false });

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then(setOptions)
      .catch(() => {});
  }, []);

  function switchMode(next: typeof mode) {
    setMode(next);
    setError("");
    setSent(null);
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
            json: { email },
          }),
        );
        return;
      }
      onDone(
        await api<{ emailFailed?: boolean }>(`/api/auth/${mode}`, {
          method: "POST",
          json: { name, email, password },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 outline-none transition focus:border-primary";
  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.2),transparent_60%)] px-4 py-10">
      <div className="grid w-full max-w-4xl items-center gap-10 md:grid-cols-2">
        <div>
          {onBack && (
            <button
              onClick={onBack}
              className="mb-6 text-sm text-zinc-400 hover:text-zinc-100"
            >
              ← Back to home
            </button>
          )}
          <LogoMark size={56} className="mb-5" />
          <h1 className="text-4xl font-semibold tracking-tight">
            Flash <span className="text-holo">AI</span>
          </h1>
          <p className="mt-3 text-lg text-zinc-400">
            One AI for everything. Ask once, and Flash picks the best AI for the
            job.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {FEATURES.map((f) => (
              <span
                key={f}
                className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-300"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
        <form
          onSubmit={submit}
          className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-2xl shadow-black/40"
        >
          <h2 className="text-xl font-semibold">
            {mode === "signup"
              ? "Create your account"
              : mode === "login"
                ? "Welcome back"
                : mode === "link"
                  ? "Email me a sign-in link"
                  : "Reset your password"}
          </h2>
          <p className="mt-1 text-sm text-zinc-400">
            {mode === "signup"
              ? "Free credits every month. No card needed."
              : mode === "login"
                ? "Sign in to pick up where you left off."
                : mode === "link"
                  ? "We'll email you a link that signs you in, no password needed. It works once, for 15 minutes."
                  : "Enter your email and we'll send you a link to choose a new password."}
          </p>
          {(mode === "signup" || mode === "login") && (options.providers.length > 0 || options.emailLink) && (
            <div className="mt-5 space-y-2">
              {options.providers.map((id) => (
                <a
                  key={id}
                  href={`/api/auth/oauth/${id}`}
                  aria-label={`Continue with ${PROVIDER_NAMES[id]}`}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-2.5 text-sm font-medium transition hover:border-zinc-700 hover:bg-zinc-800"
                >
                  <ProviderIcon id={id} />
                  Continue with {PROVIDER_NAMES[id]}
                </a>
              ))}
              {options.providers.length > 0 && <OrDivider />}
              {options.emailLink && (
                <button
                  type="button"
                  onClick={() => switchMode("link")}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-2.5 text-sm font-medium transition hover:border-zinc-700 hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M3 7l9 6 9-6" />
                  </svg>
                  Email me a sign-in link
                </button>
              )}
              {!options.providers.length && <OrDivider />}
            </div>
          )}
          <div className="mt-5 space-y-3">
            {mode === "signup" && (
              <input
                className={input}
                placeholder="Your name"
                aria-label="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            )}
            <input
              className={input}
              type="email"
              placeholder="Email"
              aria-label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            {(mode === "signup" || mode === "login") && (
              <input
                className={input}
                type="password"
                placeholder={
                  mode === "signup" ? "Password (8+ characters)" : "Password"
                }
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                required
                minLength={mode === "signup" ? 8 : undefined}
              />
            )}
          </div>
          {mode === "login" && (
            <button
              type="button"
              onClick={() => switchMode("forgot")}
              className="mt-2 text-xs text-zinc-400 hover:text-zinc-100"
            >
              Forgot password?
            </button>
          )}
          {(mode === "forgot" || mode === "link") && sent && (
            <div
              role="status"
              className="mt-3 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200"
            >
              {mode === "link"
                ? "Your sign-in link is on its way. Check your inbox and spam folder."
                : "If an account uses that email, a reset link is on its way. Check your inbox and spam folder."}
              {sent.devLink && (
                <a
                  href={sent.devLink}
                  className="mt-1 block break-all text-xs text-emerald-300 underline"
                >
                  Demo mode: open the {mode === "link" ? "sign-in" : "reset"} link
                </a>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}
          {mode === "signup" && (
            <p className="mt-3 text-xs text-zinc-500">
              By creating an account you agree to the{" "}
              <a
                href="/terms"
                target="_blank"
                className="text-zinc-300 underline hover:text-white"
              >
                Terms
              </a>{" "}
              and{" "}
              <a
                href="/privacy"
                target="_blank"
                className="text-zinc-300 underline hover:text-white"
              >
                Privacy Policy
              </a>
              .
            </p>
          )}
          <button
            disabled={busy}
            className="mt-5 w-full rounded-xl bg-brand py-2.5 font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy
              ? "One moment…"
              : mode === "signup"
                ? "Create account"
                : mode === "login"
                  ? "Sign in"
                  : mode === "link"
                    ? "Send sign-in link"
                    : "Send reset link"}
          </button>
          <p className="mt-4 text-center text-sm text-zinc-400">
            {mode === "signup"
              ? "Already have an account?"
              : mode === "login"
                ? "New to Flash?"
                : mode === "link"
                  ? "Prefer a password?"
                  : "Remembered it?"}{" "}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => switchMode(mode === "login" ? "signup" : "login")}
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}

function OrDivider() {
  return (
    <div role="separator" aria-label="or" className="flex items-center gap-3 py-1 text-xs text-zinc-500">
      <span className="h-px flex-1 bg-zinc-800" />
      or
      <span className="h-px flex-1 bg-zinc-800" />
    </div>
  );
}
