/*
 * "Install app": which kind of install the visitor's browser offers. Chrome, Edge, Samsung Internet
 * and Opera show their own install prompt; everywhere else Flash explains the browser's own steps.
 * Firefox on Windows (version 143 and later) installs web apps from a button in its address bar.
 */
import { msg } from "./i18n.ts";

export type InstallPlatform = "ios" | "android" | "mac-safari" | "firefox-windows" | "firefox" | "desktop";

export function installPlatform(userAgent: string, touchPoints = 0): InstallPlatform {
  const ua = userAgent.toLowerCase();
  // iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad.
  if (/iphone|ipad|ipod/.test(ua) || (ua.includes("macintosh") && touchPoints > 1)) return "ios";
  if (ua.includes("android")) return "android";
  if (ua.includes("firefox")) return ua.includes("windows nt") ? "firefox-windows" : "firefox";
  if (ua.includes("macintosh") && ua.includes("safari") && !/chrome|chromium|edg\//.test(ua)) return "mac-safari";
  return "desktop";
}

/** The steps to add Flash to this device, for browsers without an install prompt. */
export const INSTALL_STEPS: Record<InstallPlatform, string[]> = {
  ios: [msg("Tap the Share button (the square with an arrow)."), msg("Scroll down and tap Add to Home Screen."), msg("Tap Add.")],
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
  desktop: [msg("Open your browser's menu (⋮ or …)."), msg("Choose Install Flash AI (under Cast, save and share in Chrome, or Apps in Edge)."), msg("Click Install.")],
};
