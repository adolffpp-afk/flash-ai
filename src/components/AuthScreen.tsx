"use client";

import { useState } from "react";
import { api } from "@/lib/store";

const FEATURES = [
  "🛠️ Build and publish apps",
  "🖥️ Slides",
  "✍️ Writing",
  "🔎 Research with sources",
  "💻 Code",
  "🌍 Translation",
  "📊 Docs & sheets",
  "🎨 Images",
  "🎬 Video",
  "🎵 Music",
  "🔊 Voice",
  "📝 Transcripts",
];

export function AuthScreen({
  onDone,
  initialMode = "signup",
  onBack,
}: {
  onDone: () => void;
  initialMode?: "signup" | "login";
  onBack?: () => void;
}) {
  const [mode, setMode] = useState<"signup" | "login">(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/api/auth/${mode}`, { method: "POST", json: { name, email, password } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 outline-none transition focus:border-indigo-500";
  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_60%)] px-4 py-10">
      <div className="grid w-full max-w-4xl items-center gap-10 md:grid-cols-2">
        <div>
          {onBack && (
            <button onClick={onBack} className="mb-6 text-sm text-zinc-400 hover:text-zinc-100">
              ← Back to home
            </button>
          )}
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-pink-500 text-2xl shadow-lg shadow-fuchsia-500/20">
            ⚡
          </div>
          <h1 className="text-4xl font-semibold tracking-tight">Flash AI</h1>
          <p className="mt-3 text-lg text-zinc-400">One AI for everything. Ask once, and Flash picks the best AI for the job.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {FEATURES.map((f) => (
              <span key={f} className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-300">
                {f}
              </span>
            ))}
          </div>
        </div>
        <form onSubmit={submit} className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-2xl shadow-black/40">
          <h2 className="text-xl font-semibold">{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
          <p className="mt-1 text-sm text-zinc-400">
            {mode === "signup" ? "Free credits every month. No card needed." : "Sign in to pick up where you left off."}
          </p>
          <div className="mt-5 space-y-3">
            {mode === "signup" && (
              <input className={input} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            )}
            <input
              className={input}
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <input
              className={input}
              type="password"
              placeholder={mode === "signup" ? "Password (8+ characters)" : "Password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
            />
          </div>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          {mode === "signup" && (
            <p className="mt-3 text-xs text-zinc-500">
              By creating an account you agree to the{" "}
              <a href="/terms" target="_blank" className="text-zinc-300 underline hover:text-white">
                Terms
              </a>{" "}
              and{" "}
              <a href="/privacy" target="_blank" className="text-zinc-300 underline hover:text-white">
                Privacy Policy
              </a>
              .
            </p>
          )}
          <button
            disabled={busy}
            className="mt-5 w-full rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 py-2.5 font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
          <p className="mt-4 text-center text-sm text-zinc-400">
            {mode === "signup" ? "Already have an account?" : "New to Flash?"}{" "}
            <button
              type="button"
              className="text-indigo-400 hover:underline"
              onClick={() => {
                setMode(mode === "signup" ? "login" : "signup");
                setError("");
              }}
            >
              {mode === "signup" ? "Sign in" : "Create an account"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
