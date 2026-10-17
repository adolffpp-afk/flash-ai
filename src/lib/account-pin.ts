/*
 * Which Flash account this tab shows, once the browser is signed in to several (see the jar in
 * server/auth.ts). Each tab keeps its own in sessionStorage, which lasts through reloads and pages
 * in that tab and which no other tab sees, and names it on every request it makes (X-Flash-Account),
 * or in ?as= on the few links that can't send a header (withAccount). The server then acts as that
 * account or as nobody, never as another one, so a tab still showing one account can't log out,
 * charge, publish or connect as another.
 *
 * Storage can be missing or refuse (a private window, blocked site data): the pin is then kept for
 * this page only, and everything still works.
 */

const KEY = "flash-account";
const HEADER = "X-Flash-Account";
// A user id, as the server checks it (ACCOUNT_ID in server/auth.ts).
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// undefined until read from storage; null for no pin.
let pin: string | null | undefined;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The account this tab shows, or null when it hasn't one yet. */
export function getPin(): string | null {
  if (pin === undefined) {
    let stored: string | null = null;
    try {
      stored = storage()?.getItem(KEY) ?? null;
    } catch {
      stored = null;
    }
    pin = stored && ID.test(stored) ? stored : null;
  }
  return pin;
}

/** Makes this tab show an account from now on (null: none). */
export function setPin(id: string | null | undefined): void {
  pin = id && ID.test(id) ? id : null;
  try {
    if (pin) storage()?.setItem(KEY, pin);
    else storage()?.removeItem(KEY);
  } catch {
    // Kept for this page only.
  }
}

/** The header that names this tab's account, when it has one. */
export function accountHeaders(): Record<string, string> {
  const id = getPin();
  return id ? { [HEADER]: id } : {};
}

/** A link to one of Flash's downloads or pages that opens as this tab's account (?as=), for an <a href>. */
export function withAccount(url: string): string {
  const id = getPin();
  if (!id) return url;
  const hashAt = url.indexOf("#");
  const path = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  if (/[?&]as=/.test(path)) return url;
  return `${path}${path.includes("?") ? "&" : "?"}as=${encodeURIComponent(id)}${hash}`;
}

/**
 * The account a link opened this page as (?as=, from an email, Stripe or a callback): this tab
 * shows it from now on, and the address loses it. Returns it, so the page can say when that account
 * isn't signed in here; null when the address names none or nothing that could be an account.
 */
export function adoptAccountFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return null;
  }
  const named = url.searchParams.get("as");
  if (named === null) return null;
  url.searchParams.delete("as");
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The address keeps it; nothing else changes.
  }
  if (!ID.test(named)) return null;
  setPin(named);
  return named;
}

/** What one tab tells Flash's other tabs: an account is about to log out here, or the accounts changed. */
export type Announcement = { type: "leaving"; account: string } | { type: "changed" };

let channel: BroadcastChannel | null | undefined;
function broadcast(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("flash-accounts");
    } catch {
      channel = null;
    }
  }
  return channel;
}

/** Tells Flash's other tabs in this browser (not this one). */
export function announce(message: Announcement): void {
  try {
    broadcast()?.postMessage(message);
  } catch {
    // No other tab hears it; each still checks when it is next shown.
  }
}

/** Listens to what the other tabs announce; returns what stops listening. */
export function onAnnounce(listener: (message: Announcement) => void): () => void {
  const c = broadcast();
  if (!c) return () => {};
  const heard = (event: MessageEvent) => {
    const m = event.data as Partial<Announcement> | null;
    if (m?.type === "changed") listener({ type: "changed" });
    else if (m?.type === "leaving" && typeof m.account === "string") listener({ type: "leaving", account: m.account });
  };
  c.addEventListener("message", heard);
  return () => c.removeEventListener("message", heard);
}

/** An email address inside a translated sentence, kept apart so it reads in order in Arabic, Hebrew, Persian and Urdu. */
export const isolate = (text: string) => `⁨${text}⁩`;
