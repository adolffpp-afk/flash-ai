"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandMark } from "@/app/brand";
import { INSTALL_STEPS, installPlatform, type InstallPlatform } from "@/lib/install";

// Chrome's install prompt, which isn't in the DOM types yet.
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/**
 * The install state shared by the button and the pop-up: in Chrome, Edge and Samsung Internet
 * `install` opens the browser's own install prompt; in Safari, Firefox and the rest it shows that
 * browser's steps. `available` is false inside the installed app.
 */
export function useInstall() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [available, setAvailable] = useState(false);
  const [help, setHelp] = useState<InstallPlatform | null>(null);

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => {});
    // Known only once the page runs in a browser, not while rendering on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvailable(!installed());
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setAvailable(false);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (prompt) {
      // The prompt can only be used once; the browser sends a new one if they said no.
      setPrompt(null);
      try {
        await prompt.prompt();
        if ((await prompt.userChoice).outcome === "accepted") setAvailable(false);
        return;
      } catch {
        // Already used by the other install button: fall back to the steps.
      }
    }
    setHelp(installPlatform(navigator.userAgent, navigator.maxTouchPoints));
  }

  // In a portal, so it covers the whole page even when opened from inside a menu.
  const dialog = help && createPortal(<InstallHelp platform={help} onClose={() => setHelp(null)} />, document.body);
  return { available, install, dialog };
}

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M12 7v6m-3-3 3 3 3-3M8 20h8" />
  </svg>
);

/** An "Install app" button, hidden inside the installed app. */
export function InstallApp({ className = "" }: { className?: string }) {
  const { available, install, dialog } = useInstall();
  if (!available) return null;
  return (
    <>
      <button onClick={install} className={className}>
        <DownloadIcon />
        Install app
      </button>
      {dialog}
    </>
  );
}

const DISMISSED_KEY = "flash-install-dismissed";
const ASK_AGAIN_AFTER = 14 * 24 * 60 * 60 * 1000;

/** After signing in, a small card suggests installing Flash. "Not now" hides it for two weeks. */
export function InstallPopup() {
  const { available, install, dialog } = useInstall();
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissedAt = 0;
    try {
      dismissedAt = Number(localStorage.getItem(DISMISSED_KEY)) || 0;
    } catch {
      // Storage blocked: ask every visit.
    }
    if (Date.now() - dismissedAt < ASK_AGAIN_AFTER) return;
    // A moment after the app opens, so it doesn't cover the first thing they see.
    const timer = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(timer);
  }, []);

  function close() {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // Storage blocked: it asks again next visit.
    }
  }

  if (!available || (!show && !dialog)) return dialog || null;
  return (
    <>
      {show && (
        // On a computer it sits above the companion's Ask Flash button, so both can be clicked.
        <div
          role="dialog"
          aria-label="Install Flash AI"
          className="fixed inset-x-3 bottom-3 z-30 flex items-center gap-3 rounded-2xl border border-white/10 bg-zinc-950/95 p-4 text-zinc-100 shadow-2xl backdrop-blur-md sm:inset-x-auto sm:right-4 sm:bottom-20 sm:w-96"
        >
          <BrandMark size={44} id="flash-install" tile ring={false} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Get the Flash AI app</p>
            <p className="text-xs text-zinc-400">One tap from your home screen or desktop.</p>
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <button
              onClick={() => {
                close();
                install();
              }}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-medium text-on-brand transition hover:brightness-110"
            >
              <DownloadIcon />
              Install
            </button>
            <button onClick={close} className="h-6 text-xs text-zinc-500 hover:text-zinc-200">
              Not now
            </button>
          </div>
        </div>
      )}
      {dialog}
    </>
  );
}

function InstallHelp({ platform, onClose }: { platform: InstallPlatform; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Runs once on open: focus starts on Close, and Escape closes the dialog.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Install Flash AI"
        className="w-full max-w-md rounded-t-2xl border border-white/8 bg-zinc-950 p-6 text-zinc-100 sm:rounded-2xl sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <h2 className="text-lg font-medium tracking-tight">Install Flash AI</h2>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="text-sm text-zinc-400">Get Flash on your home screen or desktop, in its own window, with no app store needed.</p>
        <ol className="mt-4 space-y-2 text-sm text-zinc-200">
          {INSTALL_STEPS[platform].map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs text-primary-soft">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
