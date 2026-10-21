/*
 * Alerts on this phone or computer when Flash is closed (Web Push; the server side is
 * src/lib/server/push.ts, and public/sw.js shows them). The browser has one push subscription,
 * shared by the accounts signed in here (see account-pin.ts), and the server keeps a row for each
 * account that turned alerts on with it, tied to that account's sign-in here. This device also
 * remembers which accounts turned them on here (pushAccounts in device-settings.ts), so that:
 *  - the subscription is dropped once no account signed in here gets alerts by it, and with nobody
 *    signed in here: nothing can arrive for someone who signed out, even if a row was missed;
 *  - after a sign-in ends by itself (every 30 days, a password change, "Log out of all devices" on
 *    another device), alerts come back on for that account when it's signed in here again, while
 *    logging out here on purpose forgets them (logOutHere); after a new subscription (new keys on
 *    the server, or one the browser renewed), for every account signed in here that had them on;
 *  - turning them on while no other account here gets them makes a new subscription, so nothing
 *    turned on with the old one can follow;
 *  - alerts still on the screen go with the sign-in they came for, and when their account turns
 *    alerts off here (closeAlerts);
 *  - a tap on an alert while Flash is open reaches the tab the service worker brings to the front,
 *    which goes on as the alert's account when it shows another (onAlertTapped).
 */
import { useEffect } from "react";
import { api } from "./store.ts";
import { readSetting, writeSetting } from "./device-settings.ts";
import { installPlatform, onIos } from "./install.ts";
import { inAndroidApp } from "./android-shell.ts";
import { msg } from "./i18n.ts";

// "home-screen": an iPhone or iPad, which has alerts only in Flash added to the Home Screen.
// "update": one on iOS before 16.4, where not even the Home Screen app has them.
export type PushSupport = "yes" | "home-screen" | "update" | "no";

const platform = () => installPlatform(navigator.userAgent, navigator.maxTouchPoints);
const ios = () => onIos(navigator.userAgent, navigator.maxTouchPoints);
// Flash added to the Home Screen (or installed as an app), not in a browser tab.
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/**
 * Whether an iPhone or iPad is on iOS 16.4 or later, where Home Screen apps get alerts: its user
 * agent says "OS 16_1", or only Safari's "Version/16.1" on an iPad asking for desktop sites.
 * Unknown (true) when it says neither.
 */
function iosHasPush(userAgent: string): boolean {
  const found = /OS (\d+)_(\d+)/.exec(userAgent) ?? /Version\/(\d+)\.(\d+)/.exec(userAgent);
  if (!found) return true;
  const [major, minor] = [Number(found[1]), Number(found[2])];
  return major > 16 || (major === 16 && minor >= 4);
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "no";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "yes";
  if (!ios()) return "no";
  if (!iosHasPush(navigator.userAgent)) return "update";
  // Every browser on an iPhone or iPad can add Flash to the Home Screen, where alerts work, though in
  // a tab Safari has no push and Chrome, Edge and Firefox there have no service worker at all.
  return standalone() ? "no" : "home-screen";
}

/**
 * Where to allow notifications once they're blocked: the device's Settings in Flash's apps (on an
 * iPhone or iPad, Android, or a Mac's Dock, from Safari), else the browser's. Private windows answer
 * "blocked" by themselves, without asking (Chrome and Edge do), and can't allow them at all. Its
 * words, like refusedWords' and turnOnPush's, are in English and translated where they're shown, so
 * they follow a language picked after.
 */
export function blockedWords(): string {
  if (ios() && standalone()) return msg("Notifications are blocked for Flash. Allow them in Settings > Notifications > Flash ∞ AI, then try again.");
  if (platform() === "android" && inAndroidApp()) {
    return msg("Notifications are blocked for Flash. Allow them in Settings > Apps > Flash ∞ AI > Notifications, then try again.");
  }
  if (platform() === "mac-safari" && standalone()) {
    return msg("Notifications are blocked for Flash. Allow them in System Settings > Notifications > Flash ∞ AI, then try again.");
  }
  return msg("Notifications are blocked for Flash. Private windows can't show them; in a normal window, allow them in your browser's site settings, then try again.");
}

/**
 * What both notification switches in Settings (alerts and Response completions) say when the
 * browser's answer wasn't "granted": where to allow them once blocked, or, for a question closed
 * without an answer ("default"), that nothing is blocked and the next tap asks again.
 */
export function refusedWords(answer: NotificationPermission): string {
  return answer === "denied" ? blockedWords() : msg("Allow notifications when your browser asks, then try again.");
}

/**
 * Takes Flash's alerts off this screen when close says so of their account (the page an alert
 * opens names it, as=; null for one with no words, which names none), so the next person on a
 * shared computer can't read the last one's.
 */
async function closeAlerts(close: (account: string | null) => boolean): Promise<void> {
  if (pushSupport() !== "yes") return;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  for (const alert of (await reg?.getNotifications().catch(() => [])) ?? []) {
    let account: string | null = null;
    try {
      account = new URL(String((alert.data as { url?: unknown } | null)?.url)).searchParams.get("as");
    } catch {}
    if (close(account)) alert.close();
  }
}

/**
 * Once this tab's account isn't signed in here anymore while others are (Flash shows the account
 * chooser, open or after a reload): the alerts on the screen of every account but these, the ones
 * signed in here, go, as when Flash opens (syncPush). Theirs stay, and so does the subscription
 * their alerts come by.
 */
export async function closeAlertsExcept(accounts: readonly string[]): Promise<void> {
  await closeAlerts((account) => !accounts.includes(account ?? ""));
}

// An account id, as an alert's page names it (as=; ACCOUNT_ID in server/auth.ts).
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Calls tapped with the account an alert names (its page's as=) when it's tapped while this tab is
 * the Flash the service worker brings to the front (public/sw.js), which can't tell which account a
 * tab shows. Returns what stops listening.
 */
export function onAlertTapped(tapped: (account: string) => void): () => void {
  const container = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
  if (!container) return () => {};
  const heard = (event: MessageEvent) => {
    const message = event.data as { type?: unknown; url?: unknown } | null;
    if (message?.type !== "flash:open" || typeof message.url !== "string") return;
    let account: string | null = null;
    try {
      const page = new URL(message.url, window.location.href);
      if (page.origin === window.location.origin) account = page.searchParams.get("as");
    } catch {}
    if (account && ACCOUNT.test(account)) tapped(account);
  };
  container.addEventListener("message", heard);
  return () => container.removeEventListener("message", heard);
}

const wanted = () => readSetting("pushAccounts").split(" ").filter(Boolean);

function want(userId: string, on: boolean) {
  const others = wanted().filter((id) => id !== userId);
  writeSetting("pushAccounts", (on ? [...others, userId].slice(-10) : others).join(" "));
}

const bytes = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Whether a subscription was made with this public key (new keys on the server need a new one). */
function madeWith(sub: PushSubscription, key: string): boolean {
  const used = sub.options?.applicationServerKey;
  if (!used) return false;
  const a = new Uint8Array(used);
  const b = bytes(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Flash's service worker, once it runs (null if it doesn't within 10 s). */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  try {
    await navigator.serviceWorker.register("/sw.js");
    return await Promise.race([navigator.serviceWorker.ready, new Promise<null>((done) => setTimeout(() => done(null), 10_000))]);
  } catch {
    return null;
  }
}

/** This browser's push subscription, if it has one (reading it needs no worker to start). */
async function subscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "yes") return null;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  return (await reg?.pushManager.getSubscription().catch(() => null)) ?? null;
}

// on: for this tab's account; here: for any account signed in here, which then shares the subscription.
type ServerState = { key: string | null; on: boolean; here: boolean };
const serverState = async (sub: PushSubscription | null) =>
  api<ServerState>(`/api/push${sub ? `?e=${await endpointHash(sub.endpoint)}` : ""}`);

/**
 * A new subscription with the server's key, in place of any this browser had: alerts sent to the old
 * address (an account's no longer signed in here, or ones made with old keys) then never arrive, and
 * the push service answers "gone" for it, which deletes it on the server.
 */
async function subscribe(key: string): Promise<PushSubscription> {
  const reg = await worker();
  if (!reg) throw new Error("no service worker");
  const old = await reg.pushManager.getSubscription().catch(() => null);
  await old?.unsubscribe().catch(() => false);
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
}

export type PushStatus = { key: string | null; on: boolean; support: PushSupport };

// The sync under way (syncPush), if any. Syncs run one at a time, and pushStatus waits for them, so
// Settings opened meanwhile (right after a password change) shows what the sync leaves.
let syncing: Promise<void> = Promise.resolve();

/**
 * For Settings: whether alerts are set up on Flash's server at all, and on for this account here,
 * once the sync under way is done.
 */
export async function pushStatus(): Promise<PushStatus> {
  await syncing;
  const support = pushSupport();
  const sub = await subscription();
  const { key, on } = await serverState(sub);
  const granted = support === "yes" && Notification.permission === "granted";
  return { key, support, on: Boolean(on && sub && key && granted && madeWith(sub, key)) };
}

/**
 * Turns alerts on for this account here; throws with the words to show when it can't (in English
 * from here, or the server's own). Call it from a tap.
 */
export async function turnOnPush(userId: string, key: string): Promise<void> {
  if (pushSupport() !== "yes") throw new Error(msg("This browser can't get alerts when Flash is closed."));
  const blocked = blockedWords();
  // Asked first, while the tap still counts as one (browsers ask only from a tap). "default" is a
  // question closed without an answer: nothing is blocked, and the next tap asks again.
  const allowed = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (allowed !== "granted") throw new Error(refusedWords(allowed));
  let sub: PushSubscription;
  try {
    sub = await shared(key, await subscription());
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    // The browser has no push service to sign up with, which can't be told before trying: a private
    // window, or Brave with push messaging off. Trying again won't help there.
    const none = msg("This browser couldn't turn on alerts. Private windows can't get them, and some browsers, like Brave, need push messaging turned on in their settings first.");
    throw new Error(name === "NotAllowedError" ? blocked : name === "AbortError" || name === "NotSupportedError" ? none : msg("Couldn't turn on alerts. Please try again."));
  }
  await api("/api/push", { method: "POST", json: sub.toJSON() });
  want(userId, true);
}

/**
 * Turns alerts off for this account here, and takes its alerts off this screen: with its row gone,
 * nothing Flash sends later ("Log out of all devices" elsewhere, say) reaches this screen for it.
 * Once Flash's server says no other account signed in here gets alerts, the browser's subscription
 * goes too, and with it anything still on its way. When the server doesn't say (no answer, or an
 * error), the subscription stays, since another account's alerts may come by it, and this throws
 * with the words to show, so the switch stays on to try again.
 */
export async function turnOffPush(userId: string): Promise<void> {
  want(userId, false);
  await closeAlerts((account) => account === userId);
  const sub = await subscription();
  if (!sub) return;
  let left: { here?: boolean };
  try {
    left = await api<{ here?: boolean }>("/api/push", { method: "DELETE", json: { endpoint: sub.endpoint } });
  } catch (e) {
    // The server's own words (too many tries, signed out), else these.
    const said = (e as { data?: { error?: unknown } }).data?.error;
    throw typeof said === "string" && said ? e : new Error(msg("Couldn't turn off alerts. Please try again."));
  }
  if (!left.here) await sub.unsubscribe().catch(() => false);
}

/**
 * The subscription for this account to turn alerts on with: the browser's own when another account
 * signed in here gets alerts by it (made with the server's key), else a new one (see subscribe).
 */
async function shared(key: string, sub: PushSubscription | null): Promise<PushSubscription> {
  if (sub && madeWith(sub, key) && (await serverState(sub)).here) return sub;
  return subscribe(key);
}

/** Sends this browser a test alert; throws with the server's words when it can't. */
export async function sendTestPush(): Promise<void> {
  const sub = await subscription();
  await api("/api/push", { method: "POST", json: { action: "test", endpoint: sub?.endpoint ?? "" } });
}

/**
 * Puts this browser in step with who is signed in: userId is this tab's account (null for nobody
 * signed in here), accounts every account signed in here. Alerts on the screen that aren't theirs
 * go; with nobody, the subscription goes; for an account that turned alerts on here, they're turned
 * on again when the server lost them (a password change, a new sign-in, new keys on the server); a
 * subscription that no account signed in here gets alerts by goes.
 */
export function syncPush(userId: string | null, accounts: readonly string[] = []): Promise<void> {
  const done = syncing.then(() => syncNow(userId, accounts));
  syncing = done.catch(() => {});
  return done;
}

async function syncNow(userId: string | null, accounts: readonly string[]): Promise<void> {
  if (pushSupport() !== "yes") return;
  await closeAlerts((account) => !userId || (account !== userId && !accounts.includes(account ?? "")));
  const sub = await subscription();
  if (!userId) {
    await sub?.unsubscribe().catch(() => false);
    return;
  }
  const wants = wanted().includes(userId) && Notification.permission === "granted";
  // The usual case: alerts are off here, and nothing needs asking.
  if (!sub && !wants) return;
  const { key, on, here } = await serverState(sub);
  // Alerts were taken off Flash's server: nothing can come, and nothing changes here.
  if (!key) return;
  if (on && sub && madeWith(sub, key)) {
    // On, though this device forgot (its storage was cleared).
    if (!wanted().includes(userId)) want(userId, true);
    return;
  }
  if (!wants) {
    if (Notification.permission !== "granted") want(userId, false);
    // Kept while another account signed in here gets alerts by it.
    if (!here) await sub?.unsubscribe().catch(() => false);
    return;
  }
  const fresh = sub && here && madeWith(sub, key) ? sub : await subscribe(key);
  await api("/api/push", { method: "POST", json: fresh.toJSON() });
  if (fresh === sub) return;
  // A new subscription, so the other accounts signed in here that had alerts on (by the old one,
  // which no longer works) get them by it too, as from a tab of their own. One that can't (its email
  // isn't confirmed, say) stays as it is.
  for (const other of accounts.filter((id) => id !== userId && wanted().includes(id))) {
    await fetch("/api/push", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Flash-Account": other },
      body: JSON.stringify(fresh.toJSON()),
    }).catch(() => null);
  }
}

/**
 * Once these accounts were logged out here on purpose (Flash's Log out, of one account or all of
 * them; or "Log out of all devices" in Settings, which signed out every device, this one included):
 * this device forgets that they wanted alerts, so those stay off when they sign in here again (a
 * sign-in that ends by itself keeps the wish, see usePushSync), and their alerts still on the screen
 * go. The other accounts signed in here keep theirs; the next sync drops the subscription once none
 * of them gets alerts by it.
 */
export async function logOutHere(userIds: readonly string[]): Promise<void> {
  for (const id of userIds) want(id, false);
  await closeAlerts((account) => account !== null && userIds.includes(account));
}

/**
 * Keeps this browser's alerts in step with who is signed in (see syncPush): userId is this tab's
 * account, null once nobody is signed in here, and undefined while it's still loading; accounts,
 * every account signed in here; signedInAgain, a count that goes up whenever this tab's account
 * signs in here again with the tab open (Sign in again from the account chooser), which is a new
 * sign-in with the same account. A sign-in that ends by itself, with Flash open or closed, keeps this
 * device's wish for alerts; only logOutHere forgets it. Opening Flash also clears the dot alerts put
 * on its app icon.
 */
export function usePushSync(userId: string | null | undefined, accounts: readonly string[] = [], signedInAgain = 0): void {
  const all = accounts.join(" ");
  useEffect(() => {
    if (userId !== undefined) syncPush(userId, all.split(" ").filter(Boolean)).catch(() => {});
  }, [userId, all, signedInAgain]);
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === "visible") navigator.clearAppBadge?.().catch(() => {});
    };
    clear();
    document.addEventListener("visibilitychange", clear);
    // A window that was on the screen behind another app's, clicked into.
    window.addEventListener("focus", clear);
    return () => {
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("focus", clear);
    };
  }, []);
}
