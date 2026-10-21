/*
 * "Install app": which kind of install the visitor's browser offers. Chrome, Edge, Samsung Internet
 * and Opera show their own install prompt; everywhere else Flash explains the browser's own steps.
 * Firefox on Windows (version 143 and later) installs web apps from a button in its address bar.
 * On an iPhone or iPad there's no install prompt at all: Safari adds Flash to the Home Screen from its
 * Share menu, and since iOS 16.4 so do Chrome, Edge and Firefox. An app's own browser (Facebook,
 * Instagram, TikTok and the like) can't add it anywhere, so Flash asks to open it in the browser first.
 */
import { msg } from "./i18n.ts";

export type InstallPlatform = "ios" | "ios-browser" | "in-app" | "android" | "mac-safari" | "firefox-windows" | "firefox" | "desktop";

/** Whether it's an iPhone or iPad, in any browser. iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad. */
export function onIos(userAgent: string, touchPoints = 0): boolean {
  const ua = userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(ua) || (ua.includes("macintosh") && touchPoints > 1);
}

export function installPlatform(userAgent: string, touchPoints = 0): InstallPlatform {
  const ua = userAgent.toLowerCase();
  if (IN_APP.test(ua)) return "in-app";
  if (onIos(userAgent, touchPoints)) return /crios|fxios|edgios|opios/.test(ua) ? "ios-browser" : "ios";
  if (ua.includes("android")) return "android";
  if (ua.includes("firefox")) return ua.includes("windows nt") ? "firefox-windows" : "firefox";
  if (ua.includes("macintosh") && ua.includes("safari") && !/chrome|chromium|edg\//.test(ua)) return "mac-safari";
  return "desktop";
}

// The browsers inside other apps, which say so in their user agent.
const IN_APP = /fban|fbav|fb_iab|instagram|musical_ly|bytedancewebview|tiktok|snapchat|linkedinapp|pinterest|line\/|micromessenger|twitter|\bgsa\//;

/** The steps to add Flash to this device, for browsers without an install prompt. */
export const INSTALL_STEPS: Record<InstallPlatform, string[]> = {
  ios: [
    msg("Tap the Share button (the square with an arrow). On iOS 26, tap ••• at the bottom first, then Share."),
    msg("Scroll down and tap Add to Home Screen. Not there? Tap View More."),
    msg("Keep Open as Web App on, then tap Add."),
    msg("Open Flash from its new icon on your Home Screen."),
  ],
  "ios-browser": [
    msg("Tap the Share button: in Chrome it's at the right of the address bar, in Edge and Firefox it's in the menu."),
    msg("Scroll down and tap Add to Home Screen. Not there? Tap View More."),
    msg("Tap Add."),
    msg("Still no Add to Home Screen? Open www.flash-app.dev in Safari and add it from there."),
  ],
  "in-app": [
    msg("Flash is open inside another app, which can't add it to your Home Screen."),
    msg("Tap ••• or the menu, and choose Open in browser (or Open in Safari)."),
    msg("Then add Flash to your Home Screen from there."),
  ],
  android: [msg("Open your browser's menu (⋮)."), msg("Tap Install app or Add to Home screen."), msg("Tap Install.")],
  "mac-safari": [msg("In the menu bar, click File."), msg("Click Add to Dock."), msg("Click Add.")],
  "firefox-windows": [
    msg("Click the web apps button at the right of Firefox's address bar (a screen with an arrow)."),
    msg("Flash opens in its own window and is added to your Start menu."),
    msg("Click Yes to pin Flash to your taskbar."),
    msg("No button? Update Firefox (menu ☰ > Help > About Firefox): web apps need Firefox 143 or later."),
  ],
  firefox: [
    msg("Firefox on a Mac or Linux can't install web apps yet."),
    msg("Open www.flash-app.dev in Chrome or Edge."),
    msg("Click the install icon at the right of the address bar, then Install."),
  ],
  desktop: [msg("Open your browser's menu (⋮ or …)."), msg("Choose Install Flash ∞ AI (under Cast, save and share in Chrome, or Apps in Edge)."), msg("Click Install.")],
};
