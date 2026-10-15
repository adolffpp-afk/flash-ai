/*
 * Inside Flash's Android app (android/, a Trusted Web Activity) Google Play's payments rule applies:
 * digital items like credits may only be sold through Play's own billing. So the app hides plans,
 * top-ups and billing; people buy on the website. The app opens /?app=android, and Chrome sends
 * the app as the referrer; the tab then remembers it for the session. sessionStorage is per tab,
 * so the same person's Chrome browser still shows everything.
 */
import { useSyncExternalStore } from "react";
import { ANDROID_PACKAGE } from "./android-app.ts";

const KEY = "flash-shell";

/** Whether this page load came from the Android app, by its launch link or referrer. */
export function isAndroidLaunch(search: string, referrer: string): boolean {
  return new URLSearchParams(search).get("app") === "android" || referrer.startsWith(`android-app://${ANDROID_PACKAGE}`);
}

let cached: boolean | null = null;

/** True inside the Android app. Only call in the browser. */
export function inAndroidApp(): boolean {
  if (cached !== null) return cached;
  let remembered = false;
  try {
    remembered = sessionStorage.getItem(KEY) === "android";
  } catch {}
  cached = remembered || isAndroidLaunch(window.location.search, document.referrer);
  if (cached && !remembered) {
    try {
      sessionStorage.setItem(KEY, "android");
    } catch {}
  }
  return cached;
}

const subscribe = () => () => {};

/** inAndroidApp() for components; false on the server and in the first render, so hydration matches. */
export function useInAndroidApp(): boolean {
  return useSyncExternalStore(subscribe, inAndroidApp, () => false);
}
