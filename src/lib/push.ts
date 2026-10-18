/*
 * Alerts on this phone or computer when Flash is closed (Web Push; the server side is
 * src/lib/server/push.ts, and public/sw.js shows them). The browser has one push subscription, and
 * the server keeps a row for each account that turned alerts on with it, tied to that account's
 * sign-in here. This device also remembers which accounts turned them on here (pushAccounts in
 * device-settings.ts), so that:
 *  - with nobody signed in here, the browser's subscription is dropped: nothing can arrive for
 *    someone who signed out, even if a row was missed;
 *  - after a sign-in ends by itself (every 30 days, a password change, "Log out of all devices" on
 *    another device), alerts come back on for that account when it's signed in here again, while
 *    logging out here on purpose forgets them (forgetPush);
 *  - turning them on makes a new subscription, so nothing another account turned on with the old one
 *    can follow (on main a browser holds one account).
 */
import { useEffect } from "react";
import { api } from "./store.ts";
import { readSetting, writeSetting } from "./device-settings.ts";
import { installPlatform } from "./install.ts";
import type { Translate } from "./i18n.ts";

// "home-screen": an iPhone or iPad, which has alerts only in Flash added to the Home Screen.
export type PushSupport = "yes" | "home-screen" | "no";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return "no";
  const has = (name: string) => name in window;
  if (has("PushManager") && has("Notification")) return "yes";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return installPlatform(navigator.userAgent, navigator.maxTouchPoints) === "ios" && !standalone ? "home-screen" : "no";
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

type ServerState = { key: string | null; on: boolean };
const serverState = async (sub: PushSubscription | null) =>
  api<ServerState>(`/api/push${sub ? `?e=${await endpointHash(sub.endpoint)}` : ""}`);

/**
 * A new subscription with the server's key, in place of any this browser had: alerts sent to the old
 * address (another account's, or ones made with old keys) then never arrive, and the push service
 * answers "gone" for it, which deletes it on the server.
 */
async function subscribe(key: string): Promise<PushSubscription> {
  const reg = await worker();
  if (!reg) throw new Error("no service worker");
  const old = await reg.pushManager.getSubscription().catch(() => null);
  await old?.unsubscribe().catch(() => false);
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
}

export type PushStatus = { key: string | null; on: boolean; support: PushSupport };

/** For Settings: whether alerts are set up on Flash's server at all, and on for this account here. */
export async function pushStatus(): Promise<PushStatus> {
  const support = pushSupport();
  const sub = await subscription();
  const { key, on } = await serverState(sub);
  const granted = support === "yes" && Notification.permission === "granted";
  return { key, support, on: Boolean(on && sub && key && granted && madeWith(sub, key)) };
}

/** Turns alerts on for this account here; throws with the words to show when it can't. Call it from a tap. */
export async function turnOnPush(userId: string, key: string, t: Translate): Promise<void> {
  if (pushSupport() !== "yes") throw new Error(t("This browser can't get alerts when Flash is closed."));
  const blocked = t("Notifications are blocked for Flash. Allow them in your browser's site settings, then try again.");
  // Asked first, while the tap still counts as one (browsers ask only from a tap). "default" is a
  // question closed without an answer: nothing is blocked, and the next tap asks again.
  const allowed = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (allowed === "denied") throw new Error(blocked);
  if (allowed !== "granted") throw new Error(t("Allow notifications when your browser asks, then try again."));
  let sub: PushSubscription;
  try {
    sub = await subscribe(key);
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    // The browser has no push service to sign up with, which can't be told before trying: a private
    // window, or Brave with push messaging off. Trying again won't help there.
    const none = t("This browser couldn't turn on alerts. Private windows can't get them, and some browsers, like Brave, need push messaging turned on in their settings first.");
    throw new Error(name === "NotAllowedError" ? blocked : name === "AbortError" || name === "NotSupportedError" ? none : t("Couldn't turn on alerts. Please try again."));
  }
  await api("/api/push", { method: "POST", json: sub.toJSON() });
  want(userId, true);
}

/**
 * Turns alerts off for this account here. Only one account is ever signed in to Flash in a browser,
 * so the browser's subscription goes too, and with it anything still on its way.
 */
export async function turnOffPush(userId: string): Promise<void> {
  want(userId, false);
  const sub = await subscription();
  if (!sub) return;
  await api("/api/push", { method: "DELETE", json: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => false);
}

/** Sends this browser a test alert; throws with the server's words when it can't. */
export async function sendTestPush(): Promise<void> {
  const sub = await subscription();
  await api("/api/push", { method: "POST", json: { action: "test", endpoint: sub?.endpoint ?? "" } });
}

/**
 * Puts this browser in step with who is signed in (userId, or null for nobody): with nobody, the
 * subscription goes; for an account that turned alerts on here, they're turned on again when the
 * server lost them (a password change, a new sign-in, new keys on the server); a subscription that
 * no one signed in here wants goes.
 */
export async function syncPush(userId: string | null): Promise<void> {
  if (pushSupport() !== "yes") return;
  const sub = await subscription();
  if (!userId) {
    await sub?.unsubscribe().catch(() => false);
    return;
  }
  const wants = wanted().includes(userId) && Notification.permission === "granted";
  // The usual case: alerts are off here, and nothing needs asking.
  if (!sub && !wants) return;
  const { key, on } = await serverState(sub);
  // Alerts were taken off Flash's server: nothing can come, and nothing changes here.
  if (!key) return;
  if (on && sub && madeWith(sub, key)) {
    // On, though this device forgot (its storage was cleared).
    if (!wanted().includes(userId)) want(userId, true);
    return;
  }
  if (!wants) {
    if (Notification.permission !== "granted") want(userId, false);
    await sub?.unsubscribe().catch(() => false);
    return;
  }
  const fresh = await subscribe(key);
  await api("/api/push", { method: "POST", json: fresh.toJSON() });
}

/**
 * When this account logs out here on purpose (Flash's sign-out, "Log out of all devices" here): this
 * device forgets that it wanted alerts, so they stay off when it signs in here again.
 */
export function forgetPush(userId: string): void {
  want(userId, false);
}

/**
 * Keeps this browser's alerts in step with who is signed in (see syncPush): userId is the account,
 * null once nobody is, and undefined while it's still loading. A sign-in that ends by itself, with
 * Flash open or closed, keeps this device's wish for alerts; only forgetPush forgets it. Opening
 * Flash also clears the dot alerts put on its app icon.
 */
export function usePushSync(userId: string | null | undefined): void {
  useEffect(() => {
    if (userId !== undefined) syncPush(userId).catch(() => {});
  }, [userId]);
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === "visible") navigator.clearAppBadge?.().catch(() => {});
    };
    clear();
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);
}
