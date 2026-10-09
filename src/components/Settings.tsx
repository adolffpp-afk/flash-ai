"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "@/lib/store";
import { ENGINE_LABELS, type Engine } from "@/lib/types";
import { WORK_OPTIONS, firstName, fullName, initials } from "@/lib/names";
import { AUTOMATIC_LANGUAGE, LANGUAGES, speechLang } from "@/lib/languages";
import {
  DEVICE_KEYS,
  FONTS,
  TEXT_SIZES,
  THEMES,
  VOICE_RATES,
  applyAppearance,
  applyTheme,
  readAloudVoice,
  readSetting,
  writeSetting,
  type DeviceKey,
} from "@/lib/device-settings";
import { BrandKitForm } from "./BrandKit";
import { ConnectedApps } from "./ConnectedApps";
import { InstallApp } from "./InstallApp";
import { SETTINGS_TABS, type SettingsTab } from "@/lib/settings-tabs";
import { hasBuiltInRecognition } from "@/lib/listen";

export { settingsTabFor, type SettingsTab } from "@/lib/settings-tabs";

// Set on this device when the user says not to ask before costly requests (see Flash.tsx).
export const SKIP_COST_CHECK = DEVICE_KEYS.skipCostCheck;
const CONTACT = "support@flash-app.dev";

const field =
  "mt-1 block w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/60";
const label = "block text-sm text-zinc-300";
const hint = "text-xs text-zinc-500";
const button = "rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const primary = "rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-40";
const danger = "rounded-lg border border-red-500/40 px-3.5 py-1.5 text-sm text-red-300 transition hover:bg-red-500/10 disabled:opacity-40";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-b border-white/6 pb-8 last:border-0 last:pb-0">
      <h3 className="text-base font-medium text-zinc-100">{title}</h3>
      {children}
    </section>
  );
}

/** A setting with its explanation on the left and its control on the right, like Claude's rows. */
function Row({ title, about, children }: { title: string; about?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-sm text-zinc-200">{title}</p>
        {about && <p className={`mt-0.5 ${hint}`}>{about}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label: name }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 rounded-full transition ${on ? "bg-primary" : "bg-zinc-700"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-paper shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

/** A small set of choices shown as buttons, like Claude's chat font picker. */
function Choices<T extends string>({ value, options, onChange, name }: { value: T; options: readonly (readonly [T, string, ...string[]])[]; onChange: (v: T) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-2">
      {options.map(([id, title, about]) => (
        <button
          key={id || "default"}
          type="button"
          role="radio"
          aria-checked={value === id}
          title={about}
          onClick={() => onChange(id)}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            value === id ? "border-primary/70 bg-primary/10 text-white" : "border-white/10 text-zinc-300 hover:bg-white/[0.04]"
          }`}
        >
          {title}
        </button>
      ))}
    </div>
  );
}

/** A setting kept on this device, read once when Settings opens. */
function useDeviceSetting(key: DeviceKey): [string, (v: string) => void] {
  const [value, setValue] = useState(() => readSetting(key));
  return [
    value,
    (v: string) => {
      setValue(v);
      writeSetting(key, v);
    },
  ];
}

const date = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

type Usage = {
  since: number;
  refill: number;
  tools: { engine: string; credits: number; requests: number }[];
  total: number;
  freeLeft: { chat?: number; image?: number; transcribe?: number };
};
type Share = { id: string; projectId: string; title: string; createdAt: number };

const toolName = (engine: string) => (engine === "companion" ? "Ask Flash" : (ENGINE_LABELS[engine as Engine] ?? engine));

/** Everything about the user's account and how Flash works for them, in one place. */
export function Settings({
  me,
  preferences,
  initialTab = "general",
  onPreferences,
  onProfileChanged,
  onOpenCredits,
  onOpenInvite,
  onSignOut,
  onCompanionShown,
  onWakeWord,
  onClose,
}: {
  me: Me;
  preferences: string;
  initialTab?: SettingsTab;
  onPreferences: (value: string) => void;
  onProfileChanged: (user: { name: string; nickname: string; work: string; language: string }) => void;
  onOpenCredits: () => void;
  onOpenInvite: () => void;
  // everywhere: every device was signed out, this one included.
  onSignOut: (everywhere?: boolean) => void;
  // The Ask Flash button was turned on or off in Capabilities.
  onCompanionShown: (shown: boolean) => void;
  // "Hey Flash" was turned on or off in General > Voice.
  onWakeWord?: (on: boolean) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

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

  const shared = { me, busy, attempt, setMessage };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-[94dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-white/8 bg-zinc-950 text-zinc-100 sm:h-[min(720px,92dvh)] sm:rounded-2xl"
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
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/6 p-2 sm:w-52 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3"
            aria-label="Settings sections"
          >
            {SETTINGS_TABS.map(([id, title]) => (
              <button
                key={id}
                onClick={() => show(id)}
                aria-current={tab === id ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition ${
                  tab === id ? "bg-white/[0.08] font-medium text-white" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
                }`}
              >
                {title}
              </button>
            ))}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:p-8">
            <div className="flex max-w-2xl flex-col gap-8">
              {tab === "general" && (
                <General {...shared} preferences={preferences} onPreferences={onPreferences} onProfileChanged={onProfileChanged} onWakeWord={onWakeWord} />
              )}
              {tab === "account" && <Account {...shared} onSignOut={onSignOut} />}
              {tab === "privacy" && <Privacy {...shared} preferences={preferences} />}
              {tab === "billing" && <Billing {...shared} onOpenCredits={onOpenCredits} onOpenInvite={onOpenInvite} />}
              {tab === "usage" && <UsageTab {...shared} onOpenCredits={onOpenCredits} />}
              {tab === "capabilities" && <Capabilities onBrand={() => show("brand")} onCompanionShown={onCompanionShown} />}
              {tab === "brand" && (
                <Section title="Brand kit">
                  <p className={hint}>Your logo, colours and tone, used in pictures, posts, websites and documents made for your business.</p>
                  <BrandKitForm onSaved={(text) => setMessage({ text, ok: true })} />
                </Section>
              )}
              {tab === "connectors" && (
                <Section title="Connectors">
                  <p className="text-sm text-zinc-400">
                    Apps like Claude and ChatGPT can use Flash with your credits.{" "}
                    <a className="text-primary-soft underline-offset-2 hover:underline" href="/connector">
                      How to connect one
                    </a>
                  </p>
                  <ConnectedApps />
                </Section>
              )}
              {message && (
                <p role="status" className={`text-sm ${message.ok ? "text-emerald-300" : "text-red-400"}`}>
                  {message.text}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type Shared = {
  me: Me;
  busy: boolean;
  attempt: (work: () => Promise<string>) => Promise<void>;
  setMessage: (m: { text: string; ok: boolean } | null) => void;
};

function General({
  me,
  busy,
  attempt,
  setMessage,
  preferences,
  onPreferences,
  onProfileChanged,
  onWakeWord,
}: Shared & {
  preferences: string;
  onPreferences: (value: string) => void;
  onProfileChanged: (user: { name: string; nickname: string; work: string; language: string }) => void;
  onWakeWord?: (on: boolean) => void;
}) {
  const [name, setName] = useState(fullName(me.user));
  const [nickname, setNickname] = useState(me.user.nickname ?? "");
  const [work, setWork] = useState(me.user.work ?? "");
  const [language, setLanguage] = useState(me.user.language ?? "");
  // What happened to the language just picked, shown right under the menu.
  const [languageSaved, setLanguageSaved] = useState<{ text: string; ok: boolean } | null>(null);
  const [notify, setNotify] = useDeviceSetting("notifyDone");
  const [theme, setTheme] = useDeviceSetting("theme");
  const [font, setFont] = useDeviceSetting("font");
  const [size, setSize] = useDeviceSetting("textSize");
  const [keysOff, setKeysOff] = useDeviceSetting("homeKeysOff");
  const [voice, setVoice] = useDeviceSetting("voice");
  const [rate, setRate] = useDeviceSetting("voiceRate");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const speech = typeof window !== "undefined" && "speechSynthesis" in window;
  const [wake, setWake] = useDeviceSetting("wakeWord");
  const [canWake] = useState(hasBuiltInRecognition);

  // Voices load after the page in some browsers.
  useEffect(() => {
    if (!speech) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [speech]);

  const changed =
    name.trim() !== fullName(me.user) ||
    nickname.trim() !== (me.user.nickname ?? "") ||
    work !== (me.user.work ?? "");
  const save = () =>
    attempt(async () => {
      const profile = { name: name.trim() || fullName(me.user), nickname: nickname.trim(), work, language };
      await api("/api/me", { method: "PATCH", json: profile });
      onProfileChanged(profile);
      return "Profile saved.";
    });

  /** The language saves the moment it is picked, like the theme, and says so under the menu. */
  async function pickLanguage(value: string) {
    const before = language;
    setLanguage(value);
    setLanguageSaved(null);
    try {
      await api("/api/me", { method: "PATCH", json: { language: value } });
      onProfileChanged({ name: me.user.name, nickname: me.user.nickname ?? "", work: me.user.work ?? "", language: value });
      setLanguageSaved({
        text: value
          ? "Saved. Flash is now in this language, and answers in it from your next message."
          : "Saved. Flash's menus follow your browser's language, and it answers in the language you write in.",
        ok: true,
      });
    } catch {
      setLanguage(before);
      setLanguageSaved({ text: "Flash couldn't save the language. Please try again.", ok: false });
    }
  }

  async function toggleNotify(on: boolean) {
    if (!on) return setNotify("");
    if (typeof Notification === "undefined") {
      return setMessage({ text: "This browser can't show notifications.", ok: false });
    }
    const allowed = Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
    if (allowed) setNotify("1");
    else setMessage({ text: "Notifications are blocked for Flash. Allow them in your browser's site settings, then try again.", ok: false });
  }

  /** Turns "Hey Flash" on (after the browser allows the microphone) or off, on this device. */
  async function toggleWake(on: boolean) {
    if (!on) {
      setWake("");
      onWakeWord?.(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      return setMessage({ text: 'Flash needs the microphone to hear "Hey Flash". Allow it in your browser\'s site settings, then try again.', ok: false });
    }
    setWake("1");
    onWakeWord?.(true);
    setMessage({ text: 'Say "Hey Flash" any time Flash is open.', ok: true });
  }

  function tryVoice() {
    const synth = window.speechSynthesis;
    synth.cancel();
    const say = new SpeechSynthesisUtterance(`Hi ${firstName({ ...me.user, nickname })}, this is how Flash reads answers aloud.`);
    // Answers come in the language picked above, so the voice is tried in it too.
    const tag = speechLang(language, navigator.language);
    const picked = readAloudVoice(tag);
    if (picked.voice) say.voice = picked.voice;
    say.rate = picked.rate;
    say.lang = picked.voice?.lang || tag || navigator.language || "en-US";
    synth.speak(say);
  }

  // Voices in the language Flash answers in (else the browser's) first, then the rest.
  const browser = typeof navigator !== "undefined" ? navigator.language : "en";
  const lang = (speechLang(language, browser) || browser).toLowerCase().split(/[-_]/)[0];
  // No voice on this device speaks the language picked, so reading aloud would use another language's voice.
  const noVoice = speech && voices.length > 0 && Boolean(speechLang(language)) && !voices.some((v) => v.lang.toLowerCase().startsWith(lang));
  const sorted = [...voices].sort((a, b) => Number(b.lang.startsWith(lang)) - Number(a.lang.startsWith(lang)) || a.name.localeCompare(b.name));

  return (
    <>
      <Section title="Profile">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-deep text-base font-medium text-primary-soft" aria-hidden>
            {initials({ ...me.user, name })}
          </span>
          <label className={`${label} min-w-0 flex-1`}>
            Full name
            <input className={field} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <label className={`${label} min-w-0 flex-1`}>
            What should Flash call you?
            <input
              className={field}
              value={nickname}
              maxLength={40}
              placeholder={firstName({ ...me.user, name, nickname: "" })}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
        </div>
        <label className={label}>
          What best describes your work?
          <select className={field} value={work} onChange={(e) => setWork(e.target.value)}>
            <option value="">Choose one</option>
            {WORK_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <div>
          <label className={label}>
            Language
            <select className={field} value={language} onChange={(e) => void pickLanguage(e.target.value)} aria-describedby="language-hint">
              <option value="">{AUTOMATIC_LANGUAGE}</option>
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id} lang={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <p id="language-hint" className={`mt-1 ${hint}`}>
            Flash&apos;s menus and buttons, and what it answers, writes and builds, are in this language. It saves as soon as you pick it.
          </p>
          {languageSaved && (
            <p role="status" className={`mt-1 text-xs ${languageSaved.ok ? "text-emerald-300" : "text-red-400"}`}>
              {languageSaved.text}
            </p>
          )}
        </div>
        <div>
          <button className={primary} disabled={busy || !changed} onClick={save}>
            Save
          </button>
        </div>
        <label className={label}>
          What should Flash know about you?
          <span className={`mt-0.5 block ${hint}`}>Your work, your city, how you like answers. It applies to every chat and saves as you type.</span>
          <textarea
            className={`${field} resize-y`}
            rows={5}
            maxLength={2000}
            value={preferences}
            onChange={(e) => onPreferences(e.target.value)}
            placeholder="e.g. I run a small bakery in Toronto. Keep answers short."
          />
        </label>
        <p className={hint}>
          {preferences.length.toLocaleString()} / 2,000. For one project only, use the Instructions button at the top of that chat.
        </p>
      </Section>

      <Section title="Notifications">
        <Row title="Response completions" about="Get a notification on this device when Flash finishes while you're in another tab. Most useful for videos, movies and apps.">
          <Toggle on={notify === "1"} onChange={toggleNotify} label="Notify me when a response is done" />
        </Row>
      </Section>

      <Section title="Appearance">
        <Row title="Theme" about="Saved on this device.">
          <Choices
            name="Theme"
            value={theme}
            options={THEMES}
            onChange={(v) => {
              setTheme(v);
              applyTheme(v);
            }}
          />
        </Row>
        <Row title="Chat font" about="Saved on this device.">
          <Choices
            name="Chat font"
            value={font}
            options={FONTS}
            onChange={(v) => {
              setFont(v);
              applyAppearance(v, size);
            }}
          />
        </Row>
        <Row title="Text size">
          <Choices
            name="Text size"
            value={size}
            options={TEXT_SIZES}
            onChange={(v) => {
              setSize(v);
              applyAppearance(font, v);
            }}
          />
        </Row>
      </Section>

      <Section title="Keyboard">
        <Row title="Shortcuts on Home" about="Press N, V, I, D, B or T on Home to open a Quick Tool, when you're not typing. Saved on this device.">
          <Toggle on={keysOff !== "1"} onChange={(on) => setKeysOff(on ? "" : "1")} label="Use single-key shortcuts" />
        </Row>
      </Section>

      <Section title="Voice">
        <Row
          title="Talk with &ldquo;Hey Flash&rdquo;"
          about={
            canWake ? (
              <>
                While Flash is open, say &ldquo;Hey Flash&rdquo; and talk with it, hands free. Your browser does the listening: Chrome and Edge send
                the sound to Google&apos;s or Microsoft&apos;s speech service to understand it, and Flash only gets what you say after &ldquo;Hey
                Flash&rdquo;. A green dot on the Talk button shows it&apos;s listening. Saved on this device.
              </>
            ) : (
              <>
                This browser can&apos;t listen for &ldquo;Hey Flash&rdquo;. It works in Chrome, Edge and Safari. Here, press the Talk button next to
                the mic to start a voice conversation.
              </>
            )
          }
        >
          {canWake ? <Toggle on={wake === "1"} onChange={toggleWake} label="Listen for Hey Flash" /> : <span className={hint}>Not in this browser</span>}
        </Row>
        {speech ? (
          <>
            <Row title="Read-aloud voice" about="The voice 🔊 Read aloud uses. Read aloud is free; the voices come with your device.">
              <select className={`${field} mt-0 max-w-[16rem]`} value={voice} onChange={(e) => setVoice(e.target.value)} aria-label="Read-aloud voice">
                <option value="">Device default</option>
                {sorted.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </Row>
            {noVoice && (
              <p className={hint}>
                This device has no voice for the language Flash answers in, so answers are read with another language&apos;s voice. Add one in your
                computer&apos;s speech or language settings, then reopen Flash.
              </p>
            )}
            <Row title="Speed">
              <Choices name="Read-aloud speed" value={rate} options={VOICE_RATES} onChange={setRate} />
            </Row>
            <div>
              <button className={button} onClick={tryVoice}>
                🔊 Try it
              </button>
            </div>
          </>
        ) : (
          <p className={hint}>This browser can&apos;t read answers aloud.</p>
        )}
      </Section>

      <Section title="App">
        <Row title="Install Flash" about="Put Flash on your home screen or desktop and open it like an app.">
          <InstallApp className={`${button} inline-flex items-center gap-2`} />
        </Row>
      </Section>
    </>
  );
}

function Account({ me, busy, attempt, onSignOut }: Shared & { onSignOut: (everywhere?: boolean) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState<"" | "everywhere" | "delete">("");
  const [copied, setCopied] = useState(false);

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

  const signOutEverywhere = () =>
    attempt(async () => {
      await api("/api/auth/logout", { method: "POST", json: { everywhere: true } });
      onSignOut(true);
      return "Signed out everywhere.";
    });

  return (
    <>
      <Section title="Account">
        <Row title="Email">
          <span className="text-sm text-zinc-300">{me.user.email}</span>
        </Row>
        <Row title="Log out" about="Sign out of Flash on this device.">
          <button className={button} onClick={() => onSignOut()}>
            Log out
          </button>
        </Row>
        <Row title="Log out of all devices" about="Signs you out everywhere, this device included. Connected apps keep working until you disconnect them.">
          {confirm === "everywhere" ? (
            <span className="flex gap-2">
              <button className={danger} disabled={busy} onClick={signOutEverywhere}>
                Log out everywhere
              </button>
              <button className={button} onClick={() => setConfirm("")}>
                Cancel
              </button>
            </span>
          ) : (
            <button className={button} onClick={() => setConfirm("everywhere")}>
              Log out of all devices
            </button>
          )}
        </Row>
        <Row title="Delete your account" about="Deletes your account, chats, files and websites for good.">
          <button className={danger} onClick={() => setConfirm(confirm === "delete" ? "" : "delete")}>
            Delete account
          </button>
        </Row>
        {confirm === "delete" && (
          <p role="status" className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-sm text-zinc-300">
            To delete your account and everything in it, email <span className="select-all text-zinc-100">{CONTACT}</span> from {me.user.email}. We
            confirm by email before anything is deleted.
          </p>
        )}
        <Row title="Account ID" about="Support may ask for it.">
          <span className="flex items-center gap-2">
            <code className="select-all rounded bg-white/[0.05] px-2 py-0.5 text-xs text-zinc-300">{me.user.id}</code>
            <button
              className="text-xs text-primary-soft hover:underline"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(me.user.id)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => {})
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </Row>
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
            <p className="text-sm text-zinc-400">
              You sign in with Google or an email link, so there&apos;s no password yet. You can add one to sign in with your email and a password too.
            </p>
            <div>
              <button className={button} disabled={busy} onClick={emailLink}>
                Email me a link to set a password
              </button>
            </div>
          </>
        )}
      </Section>
    </>
  );
}

/** Downloads a file made in the browser. */
function saveFile(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Privacy({ me, busy, attempt, preferences }: Shared & { preferences: string }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    api<{ shares: Share[] }>("/api/shares")
      .then((r) => setShares(r.shares))
      .catch(() => setShares([]));
  }, []);

  const exportData = () =>
    attempt(async () => {
      const { projects } = await api<{ projects: { id: string; name: string }[] }>("/api/projects");
      const chats = [];
      for (const [i, p] of projects.entries()) {
        setProgress(`Exporting chat ${i + 1} of ${projects.length}…`);
        chats.push((await api<{ project: unknown }>(`/api/projects/${p.id}`)).project);
      }
      setProgress("");
      const [brand, sites] = await Promise.all([
        api<{ brand: unknown }>("/api/brand").catch(() => ({ brand: null })),
        api<{ sites: unknown[] }>("/api/sites").catch(() => ({ sites: [] })),
      ]);
      const data = {
        exported: new Date().toISOString(),
        account: { id: me.user.id, email: me.user.email, name: me.user.name, nickname: me.user.nickname ?? "", work: me.user.work ?? "" },
        memory: preferences,
        brandKit: brand.brand,
        websites: sites.sites,
        chats,
      };
      saveFile(JSON.stringify(data, null, 2), `flash-export-${new Date().toISOString().slice(0, 10)}.json`);
      return `Exported ${chats.length} chat${chats.length === 1 ? "" : "s"}. Check your downloads.`;
    }).finally(() => setProgress(""));

  const stop = (id: string) =>
    attempt(async () => {
      await api(`/api/shares?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setShares((list) => list?.filter((s) => s.id !== id) ?? null);
      return "That link stopped working.";
    });

  return (
    <>
      <Section title="Privacy">
        <p className="text-sm text-zinc-300">
          Flash never uses your chats or files to train AI models. Read how your data is handled in the{" "}
          <a className="text-primary-soft underline-offset-2 hover:underline" href="/privacy" target="_blank" rel="noreferrer">
            Privacy Policy
          </a>
          .
        </p>
        <Row title="Export data" about="Download your chats, memory, brand kit and websites as one file.">
          <button className={button} disabled={busy} onClick={exportData}>
            {progress || "Export data"}
          </button>
        </Row>
      </Section>
      <Section title="Shared chats">
        <p className={hint}>Anyone with one of these links can read that chat as it was when you shared it.</p>
        {shares === null ? (
          <p className={hint}>Loading…</p>
        ) : shares.length === 0 ? (
          <p className="text-sm text-zinc-400">You haven&apos;t shared any chats.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-white/6 rounded-xl border border-white/8">
            {shares.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <a href={`/s/${s.id}`} target="_blank" rel="noreferrer" className="block truncate text-zinc-200 hover:underline">
                    {s.title}
                  </a>
                  <span className={hint}>Shared {date(s.createdAt)}</span>
                </span>
                <button className={button} disabled={busy} onClick={() => stop(s.id)}>
                  Stop sharing
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function Billing({ me, busy, attempt, onOpenCredits, onOpenInvite }: Shared & { onOpenCredits: () => void; onOpenInvite: () => void }) {
  const canManage = Boolean(me.plan && !me.plan.test && me.paymentsEnabled);
  const portal = () =>
    attempt(async () => {
      const res = await api<{ url?: string }>("/api/billing/portal", { method: "POST" });
      if (res.url) window.location.assign(res.url);
      return "Opening billing…";
    });
  return (
    <Section title="Billing">
      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-zinc-400">Your plan</p>
            <p className="mt-0.5 text-lg font-medium">{me.plan ? `${me.plan.name} plan (${me.plan.interval === "year" ? "yearly" : "monthly"})` : "Free plan"}</p>
            {me.plan ? (
              <p className={`mt-1 ${hint}`}>{me.plan.renews ? `Renews, next credits on ${date(me.plan.nextCredits)}` : `Ends on ${date(me.plan.paidUntil)}`}</p>
            ) : (
              <p className={`mt-1 ${hint}`}>{me.freeMonthly.toLocaleString()} free credits every month.</p>
            )}
          </div>
          <button className={primary} onClick={onOpenCredits}>
            {me.plan ? "Adjust plan" : "Upgrade"}
          </button>
        </div>
        <p className="mt-4 text-sm text-zinc-400">Credits</p>
        <p className="mt-0.5 text-lg font-medium">{me.credits.toLocaleString()}</p>
      </div>
      {canManage && (
        <Row title="Payment method and invoices" about="Update your card, download invoices or cancel, on Stripe's secure page.">
          <button className={button} disabled={busy} onClick={portal}>
            Manage
          </button>
        </Row>
      )}
      <Row title="Buy credits" about="One-off top-ups that never expire.">
        <button className={button} onClick={onOpenCredits}>
          Buy credits
        </button>
      </Row>
      <Row title="Invite friends" about="You both get credits when they make their first payment.">
        <button className={button} onClick={onOpenInvite}>
          🎁 Invite friends
        </button>
      </Row>
    </Section>
  );
}

function UsageTab({ me, onOpenCredits }: Shared & { onOpenCredits: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<Usage>("/api/me/usage")
      .then(setUsage)
      .catch(() => setFailed(true));
  }, []);
  const most = Math.max(1, ...(usage?.tools.map((t) => t.credits) ?? [1]));
  return (
    <>
      <Section title="Credits">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-3xl font-medium tabular-nums">{me.credits.toLocaleString()}</p>
            <p className={hint}>
              credits left
              {usage && !me.plan ? ` · free credits refill on ${date(usage.refill)}` : me.plan ? ` · next plan credits on ${date(me.plan.nextCredits)}` : ""}
            </p>
          </div>
          <button className={button} onClick={onOpenCredits}>
            Get more credits
          </button>
        </div>
      </Section>
      <Section title="This month">
        {failed ? (
          <p className="text-sm text-red-400">Couldn&apos;t load your usage. Please try again.</p>
        ) : !usage ? (
          <p className={hint}>Loading…</p>
        ) : usage.tools.length === 0 ? (
          <p className="text-sm text-zinc-400">Nothing used yet this month.</p>
        ) : (
          <>
            <p className="text-sm text-zinc-300">
              <span className="font-medium tabular-nums">{usage.total.toLocaleString()}</span> credits used since {date(usage.since)}
            </p>
            <ul className="flex flex-col gap-3">
              {usage.tools.map((t) => (
                <li key={t.engine} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-zinc-200">{toolName(t.engine)}</span>
                    <span className="tabular-nums text-zinc-400">
                      {t.credits.toLocaleString()} credits · {t.requests.toLocaleString()} {t.requests === 1 ? "request" : "requests"}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (t.credits / most) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
      {usage && (me.freeLane.chats > 0 || me.freeLane.images > 0) && (
        <Section title="Free use today">
          <p className={hint}>When your credits run out, free models still answer, up to a daily limit.</p>
          <ul className="flex flex-col gap-1 text-sm text-zinc-300">
            {me.freeLane.chats > 0 && (
              <li>
                Messages: <span className="tabular-nums">{usage.freeLeft.chat ?? me.freeLane.chats}</span> of {me.freeLane.chats} left
              </li>
            )}
            {me.freeLane.images > 0 && (
              <li>
                Images: <span className="tabular-nums">{usage.freeLeft.image ?? me.freeLane.images}</span> of {me.freeLane.images} left
              </li>
            )}
            {!!me.freeLane.transcripts && (
              <li>
                Transcripts: <span className="tabular-nums">{usage.freeLeft.transcribe ?? me.freeLane.transcripts}</span> of {me.freeLane.transcripts} left
              </li>
            )}
          </ul>
        </Section>
      )}
      {me.activity.length > 0 && (
        <Section title="Recent activity">
          <ul className="flex flex-col divide-y divide-white/6 text-sm">
            {me.activity.slice(0, 12).map((a, i) => (
              <li key={i} className="flex justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-zinc-300">{a.reason}</span>
                <span className={`shrink-0 tabular-nums ${a.amount < 0 ? "text-zinc-400" : "text-emerald-300"}`}>
                  {a.amount > 0 ? "+" : ""}
                  {a.amount.toLocaleString()} · {new Date(a.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function Capabilities({ onBrand, onCompanionShown }: { onBrand: () => void; onCompanionShown: (shown: boolean) => void }) {
  const [skipCost, setSkipCost] = useDeviceSetting("skipCostCheck");
  const [memoryOff, setMemoryOff] = useDeviceSetting("memoryOff");
  const [hideCompanion, setHideCompanion] = useDeviceSetting("hideCompanion");
  return (
    <>
      <Section title="Memory">
        <Row title="Use memory in chats" about="Flash uses what you told it about yourself (in General) in every chat. Project instructions and your brand kit still apply when it's off. Saved on this device.">
          <Toggle on={memoryOff !== "1"} onChange={(on) => setMemoryOff(on ? "" : "1")} label="Use memory in chats" />
        </Row>
      </Section>
      <Section title="Spending">
        <Row title="Ask before costly requests" about="Flash shows the price first for anything that uses 50 credits or more, like videos and movies. Saved on this device.">
          <Toggle on={skipCost !== "1"} onChange={(on) => setSkipCost(on ? "" : "1")} label="Ask before requests that use 50 credits or more" />
        </Row>
      </Section>
      <Section title="Ask Flash">
        <Row title="Show the Ask Flash button" about="A chat beside your work for questions about Flash and what it's doing. Saved on this device.">
          <Toggle
            on={hideCompanion !== "1"}
            onChange={(on) => {
              setHideCompanion(on ? "" : "1");
              onCompanionShown(on);
            }}
            label="Show the Ask Flash button"
          />
        </Row>
      </Section>
      <Section title="Brand kit">
        <Row title="Your brand in everything Flash makes" about="Your logo, colours and tone, used in pictures, posts, websites and documents for your business.">
          <button className={button} onClick={onBrand}>
            Edit brand kit
          </button>
        </Row>
      </Section>
    </>
  );
}
