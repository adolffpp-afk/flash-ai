"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "@/lib/store";
import { BrandKitForm } from "./BrandKit";
import { ConnectedApps } from "./ConnectedApps";
import { InstallApp } from "./InstallApp";

export type SettingsTab = "profile" | "memory" | "brand" | "plan" | "apps" | "preferences" | "account";

const TABS: [SettingsTab, string, string][] = [
  ["profile", "👤", "Profile"],
  ["memory", "🧠", "Memory"],
  ["brand", "🎨", "Brand kit"],
  ["plan", "⚡", "Plan & credits"],
  ["apps", "🔌", "Connected apps"],
  ["preferences", "⚙️", "Preferences"],
  ["account", "🔒", "Account"],
];

// Set on this device when the user says not to ask before costly requests (see Flash.tsx).
export const SKIP_COST_CHECK = "flash:skip-cost-check";
const CONTACT = "support@flash-app.dev";

const field =
  "mt-1 block w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/60";
const label = "block text-xs font-medium text-zinc-400";
const button = "rounded-full border border-white/10 px-4 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const primary = "rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

/** Everything about the user's account and how Flash works for them, in one place. */
export function Settings({
  me,
  preferences,
  initialTab = "profile",
  onPreferences,
  onNameChanged,
  onOpenCredits,
  onOpenInvite,
  onSignOut,
  onClose,
}: {
  me: Me;
  preferences: string;
  initialTab?: SettingsTab;
  onPreferences: (value: string) => void;
  onNameChanged: (name: string) => void;
  onOpenCredits: () => void;
  onOpenInvite: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [name, setName] = useState(me.user.name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // Settings opens only after a click, so the device's setting can be read straight away.
  const [askCost, setAskCost] = useState(() => {
    try {
      return localStorage.getItem(SKIP_COST_CHECK) !== "1";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const show = (t: SettingsTab) => {
    setTab(t);
    setMessage(null);
  };

  async function attempt(work: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ text: await work(), ok: true });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Something went wrong. Please try again.", ok: false });
    }
    setBusy(false);
  }

  const saveName = () =>
    attempt(async () => {
      await api("/api/me", { method: "PATCH", json: { name } });
      onNameChanged(name.trim());
      return "Name saved.";
    });

  const changePassword = () =>
    attempt(async () => {
      await api("/api/me/password", { method: "POST", json: { current, next } });
      setCurrent("");
      setNext("");
      return "Password changed. Your other devices were signed out.";
    });

  const emailLink = () =>
    attempt(async () => {
      await api("/api/auth/reset/request", { method: "POST", json: { email: me.user.email } });
      return `We sent a link to ${me.user.email}. Open it to set a new password.`;
    });

  function toggleAskCost(on: boolean) {
    setAskCost(on);
    try {
      if (on) localStorage.removeItem(SKIP_COST_CHECK);
      else localStorage.setItem(SKIP_COST_CHECK, "1");
    } catch {}
  }

  const date = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-white/8 bg-zinc-950 text-zinc-100 sm:h-[min(640px,90dvh)] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/6 px-5 py-3">
          <h2 className="text-lg font-medium tracking-tight">Settings</h2>
          <button onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/6 p-2 sm:w-48 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r"
            aria-label="Settings sections"
          >
            {TABS.map(([id, icon, title]) => (
              <button
                key={id}
                onClick={() => show(id)}
                aria-current={tab === id ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition ${
                  tab === id ? "bg-white/[0.07] text-white" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
                }`}
              >
                <span className="mr-2" aria-hidden>
                  {icon}
                </span>
                {title}
              </button>
            ))}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:p-6">
            {tab === "profile" && (
              <div className="flex flex-col gap-8">
                <Section title="Profile">
                  <label className={label}>
                    Name
                    <input className={field} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <div>
                    <span className={label}>Email</span>
                    <p className="mt-1 text-sm text-zinc-200">{me.user.email}</p>
                  </div>
                  <div>
                    <button className={primary} disabled={busy || !name.trim() || name.trim() === me.user.name} onClick={saveName}>
                      Save
                    </button>
                  </div>
                </Section>
                <Section title="Password">
                  {me.hasPassword ? (
                    <>
                      <label className={label}>
                        Current password
                        <input className={field} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
                      </label>
                      <label className={label}>
                        New password (at least 8 characters)
                        <input className={field} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
                      </label>
                      <div className="flex flex-wrap items-center gap-3">
                        <button className={primary} disabled={busy || !current || next.length < 8} onClick={changePassword}>
                          Change password
                        </button>
                        <button className="text-xs text-zinc-400 hover:text-zinc-100" disabled={busy} onClick={emailLink}>
                          Forgot it? Email me a link
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-zinc-400">You sign in with Google or an email link, so there&apos;s no password yet. You can add one to sign in with your email and a password too.</p>
                      <div>
                        <button className={button} disabled={busy} onClick={emailLink}>
                          Email me a link to set a password
                        </button>
                      </div>
                    </>
                  )}
                </Section>
              </div>
            )}

            {tab === "memory" && (
              <Section title="Memory">
                <p className="text-sm text-zinc-400">
                  What Flash should know about you in every chat: your work, your city, how you like answers. It saves as you type.
                </p>
                <textarea
                  className={`${field} resize-y`}
                  rows={7}
                  maxLength={2000}
                  value={preferences}
                  onChange={(e) => onPreferences(e.target.value)}
                  placeholder="e.g. I run a small bakery in Toronto. Keep answers short."
                  aria-label="Memory"
                />
                <p className="text-xs text-zinc-500">
                  {preferences.length.toLocaleString()} / 2,000. For one project only, use the Instructions button at the top of that chat.
                </p>
              </Section>
            )}

            {tab === "brand" && (
              <Section title="Brand kit">
                <BrandKitForm onSaved={(text) => setMessage({ text, ok: true })} />
              </Section>
            )}

            {tab === "plan" && (
              <Section title="Plan & credits">
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
                  <p className="text-sm text-zinc-400">Your plan</p>
                  <p className="mt-0.5 text-lg font-medium">{me.plan ? `${me.plan.name} (${me.plan.interval === "year" ? "yearly" : "monthly"})` : "Free"}</p>
                  {me.plan && (
                    <p className="mt-1 text-xs text-zinc-500">
                      {me.plan.renews ? `Renews, next credits on ${date(me.plan.nextCredits)}` : `Ends on ${date(me.plan.paidUntil)}`}
                    </p>
                  )}
                  <p className="mt-4 text-sm text-zinc-400">Credits</p>
                  <p className="mt-0.5 text-lg font-medium">{me.credits.toLocaleString()}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className={primary} onClick={onOpenCredits}>
                    {me.plan ? "Manage plan & credits" : "Get more credits"}
                  </button>
                  <button className={button} onClick={onOpenInvite}>
                    🎁 Invite friends, earn credits
                  </button>
                </div>
              </Section>
            )}

            {tab === "apps" && (
              <Section title="Connected apps">
                <p className="text-sm text-zinc-400">
                  Apps like Claude that use Flash with your credits. <a className="text-primary-soft underline-offset-2 hover:underline" href="/connector">How to connect one</a>
                </p>
                <ConnectedApps />
              </Section>
            )}

            {tab === "preferences" && (
              <div className="flex flex-col gap-8">
                <Section title="Spending">
                  <label className="flex items-start gap-3 text-sm text-zinc-200">
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-emerald-500" checked={askCost} onChange={(e) => toggleAskCost(e.target.checked)} />
                    <span>
                      Ask before requests that use 50 credits or more
                      <span className="block text-xs text-zinc-500">Like videos and movies. Saved on this device.</span>
                    </span>
                  </label>
                </Section>
                <Section title="App">
                  <p className="text-sm text-zinc-400">Put Flash on your home screen or desktop and open it like an app.</p>
                  <div>
                    <InstallApp className={`${button} inline-flex items-center gap-2`} />
                  </div>
                </Section>
              </div>
            )}

            {tab === "account" && (
              <div className="flex flex-col gap-8">
                <Section title="Sign out">
                  <p className="text-sm text-zinc-400">Signed in as {me.user.email}.</p>
                  <div>
                    <button className={button} onClick={onSignOut}>
                      Sign out
                    </button>
                  </div>
                </Section>
                <Section title="Your data">
                  <p className="text-sm text-zinc-400">
                    Read how Flash handles your data in the <a className="text-primary-soft underline-offset-2 hover:underline" href="/privacy">Privacy Policy</a>. To
                    delete your account and everything in it, email <span className="select-all text-zinc-200">{CONTACT}</span> from {me.user.email}.
                  </p>
                </Section>
              </div>
            )}

            {message && (
              <p role="status" className={`mt-5 text-sm ${message.ok ? "text-emerald-300" : "text-red-400"}`}>
                {message.text}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
