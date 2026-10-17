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
// The email of the account the tab shows, so after a reload it can say which one was logged out.
const EMAIL_KEY = "flash-account-email";
const HEADER = "X-Flash-Account";
// A user id, as the server checks it (ACCOUNT_ID in server/auth.ts).
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// undefined until read from storage; null for no pin.
let pin: string | null | undefined;
// The pin's email, kept here too for when storage refuses.
let pinEmail: string | null = null;

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
  const before = getPin();
  pin = id && ID.test(id) ? id : null;
  if (pin !== before) pinEmail = null;
  try {
    if (pin) storage()?.setItem(KEY, pin);
    else storage()?.removeItem(KEY);
    if (pin !== before) storage()?.removeItem(EMAIL_KEY);
  } catch {
    // Kept for this page only.
  }
}

/** Remembers the email of the account this tab shows (its pin), for after a reload. */
export function setPinEmail(email: string): void {
  if (!getPin()) return;
  pinEmail = email;
  try {
    storage()?.setItem(EMAIL_KEY, email);
  } catch {
    // Kept for this page only.
  }
}

/** The email of the account this tab shows, when known ("" otherwise). */
export function getPinEmail(): string {
  if (!getPin()) return "";
  try {
    return storage()?.getItem(EMAIL_KEY) ?? pinEmail ?? "";
  } catch {
    return pinEmail ?? "";
  }
}

/**
 * Whether the server's answer for an account is this tab's to show: its own account, or the
 * browser's default while it has none yet. An answer asked for before the tab moved to another
 * account (a switch, which then reloads it) is not, and must never move it back.
 */
export function isTabAccount(account: string): boolean {
  const mine = getPin();
  return !mine || mine === account;
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

// Where the link that named this page's account was going (its path and query, without ?as=).
let linked: string | null = null;

/**
 * The account a link opened this page as (?as=, from an email, Stripe or a callback): this tab
 * shows it from now on, and the address loses it. Returns it, so the page can say when that account
 * isn't signed in here; null when the address names none or nothing that could be an account, and
 * when it is this tab's own switch (switchAddress), which no link waits on.
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
  const switched = url.searchParams.get("switched") === "1";
  url.searchParams.delete("as");
  url.searchParams.delete("switched");
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The address keeps it; nothing else changes.
  }
  if (!ID.test(named)) return null;
  setPin(named);
  if (switched) return null;
  linked = `${url.pathname}${url.search}`;
  return named;
}

/**
 * The address that reloads this tab as another account signed in here (Switch, the next account
 * after a log out, or the account just added), at to: a page of Flash itself (like /?apps=1), Home
 * when none. The tab's account changes only once that page loads (adoptAccountFromUrl), so a reload
 * the browser keeps from happening ("Leave site?", Stay) leaves the tab on the account it shows,
 * naming that account in every request. It always loads a page, even when to differs from this
 * address only by its #.
 */
export function switchAddress(id: string, to = "/"): string {
  const url = new URL(to, "https://flash.invalid");
  url.searchParams.set("as", id);
  url.searchParams.set("switched", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** What a tab says once it has reloaded as the next account after a log out: who left, and who it uses now. */
export type LeftNote = { email: string; next: string };
// Kept in this tab's sessionStorage across that reload.
const NOTE_KEY = "flash-notice";

/**
 * Reloads this tab as another account signed in here: Switch, the next account after a log out
 * (note: what the new page says about it), or the account just signed in to in Add another account
 * (to: the page of Flash it was for). It never names that account itself: the new page does
 * (adoptAccountFromUrl), so until it loads, and if the browser's "Leave site?" keeps this page
 * (Stay), every request still names the account this tab shows. Every switch goes through here.
 */
export function reloadAs(id: string, note?: LeftNote, to?: string): void {
  if (note) {
    try {
      storage()?.setItem(NOTE_KEY, JSON.stringify(note));
    } catch {
      // Storage blocked: no note.
    }
  }
  announce({ type: "changed" });
  // A fresh page clears everything of the account before (its chats, files kept in memory, the
  // queue, the wake word), and Back can't return to it.
  window.location.replace(switchAddress(id, to));
}

/** The note reloadAs left for this tab, once: null when there is none (or storage refuses). */
export function takeLeftNote(): LeftNote | null {
  try {
    const left = storage()?.getItem(NOTE_KEY);
    if (!left) return null;
    storage()?.removeItem(NOTE_KEY);
    const note = JSON.parse(left) as Partial<LeftNote> | null;
    return typeof note?.email === "string" && typeof note.next === "string" ? { email: note.email, next: note.next } : null;
  } catch {
    return null;
  }
}

/**
 * Where the link that named this page's account was going (like /?apps=1), to go on to after
 * signing in to that account from the account chooser; null when no link named one. The page
 * takes those parts out of the address once it has opened them.
 */
export const linkTarget = (): string | null => linked;

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
