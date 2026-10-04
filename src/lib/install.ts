/*
 * "Install app": which kind of install the visitor's browser offers. Chrome, Edge, Samsung Internet
 * and Opera show their own install prompt; everywhere else Flash explains the browser's own steps.
 */
export type InstallPlatform = "ios" | "android" | "mac-safari" | "firefox" | "desktop";

export function installPlatform(userAgent: string, touchPoints = 0): InstallPlatform {
  const ua = userAgent.toLowerCase();
  // iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad.
  if (/iphone|ipad|ipod/.test(ua) || (ua.includes("macintosh") && touchPoints > 1)) return "ios";
  if (ua.includes("android")) return "android";
  if (ua.includes("firefox")) return "firefox";
  if (ua.includes("macintosh") && ua.includes("safari") && !/chrome|chromium|edg\//.test(ua)) return "mac-safari";
  return "desktop";
}

/** The steps to add Flash to this device, for browsers without an install prompt. */
export const INSTALL_STEPS: Record<InstallPlatform, string[]> = {
  ios: ["Tap the Share button (the square with an arrow).", "Scroll down and tap Add to Home Screen.", "Tap Add."],
  android: ["Open your browser's menu (⋮).", "Tap Install app or Add to Home screen.", "Tap Install."],
  "mac-safari": ["In the menu bar, click File.", "Click Add to Dock.", "Click Add."],
  firefox: [
    "Firefox on a computer can't install web apps yet.",
    "Open www.flash-app.dev in Chrome or Edge.",
    "Click the install icon at the right of the address bar, then Install.",
  ],
  desktop: ["Open your browser's menu (⋮ or …).", "Choose Install Flash AI (under Cast, save and share in Chrome, or Apps in Edge).", "Click Install."],
};
