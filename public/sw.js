// Flash ∞ AI's service worker. It lets browsers install Flash as an app, and shows a short message
// instead of the browser's error page when an installed Flash opens without a connection. It keeps no
// cache. VERSION changes with the brand, so browsers install this worker again; installed apps get the
// new icon from the manifest's new icon addresses (see src/app/manifest.ts). It also shows the alerts
// Flash sends when it's closed (Web Push, see src/lib/server/push.ts), and a tap on one opens Flash.
const VERSION = "flash-infinity-1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flash ∞ AI</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0c10;color:#e4e4e7;font-family:system-ui,sans-serif;text-align:center">
<div><p style="font-size:20px;font-weight:600;margin:0 0 8px">You're offline</p><p style="color:#a1a1aa;margin:0 0 20px">Flash needs the internet. Reconnect and try again.</p>
<button onclick="location.reload()" style="background:#5b8cf6;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:15px">Try again</button></div>`;

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
  );
});

// A Flash page an alert opens; anything else (another site, a broken address) opens Flash's home.
function flashPage(url) {
  try {
    const page = new URL(typeof url === "string" ? url : "/", self.location.origin);
    if (page.origin === self.location.origin) return page.href;
  } catch {}
  return new URL("/", self.location.origin).href;
}

// The SHA-256 of this browser's push address, as the page sends it (src/lib/push.ts), so the address stays out of logs.
async function addressHash(sub) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub.endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Whether the sign-in that turned alerts on here is still live, asked of Flash before an alert shows
// its words: one may have waited at the push service (a phone or laptop that was off) through a log
// out, "Log out of all devices", a password change or the sign-in ending. "off" also drops this
// browser's subscription, so nothing else waiting for it arrives (Flash makes a new one when that
// account signs in here again and wants alerts); "unknown" (no answer) keeps it.
async function stillOn() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return "off";
    const res = await fetch(`/api/push?e=${await addressHash(sub)}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {}),
    });
    if (res.status !== 401 && !res.ok) return "unknown";
    const on = res.ok && (await res.json()).on === true;
    if (!on) await sub.unsubscribe().catch(() => false);
    return on ? "on" : "off";
  } catch {
    return "unknown";
  }
}

// An alert: {title, body, url, tag}, already in the account's language. A later one with the same tag
// replaces it and still alerts; one with none shows on its own. Browsers require every push to show
// something, so one that can't be read, or whose sign-in here isn't live, shows Flash's name only.
self.addEventListener("push", (event) => {
  const text = (value) => (typeof value === "string" ? value : "");
  const show = async () => {
    let alert = {};
    try {
      alert = event.data ? event.data.json() : {};
    } catch {}
    if ((await stillOn()) !== "on") alert = {};
    const tag = text(alert.tag);
    await self.registration.showNotification(text(alert.title) || "Flash ∞ AI", {
      body: text(alert.body),
      icon: "/app-icon/192?v=3",
      data: { url: flashPage(alert.url) },
      ...(tag ? { tag, renotify: true } : {}),
    });
  };
  // A dot on the installed app's icon until Flash is opened again (it clears it).
  const badge = self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : Promise.resolve();
  event.waitUntil(Promise.all([show(), badge]));
});

// Flash itself is its home page; its other pages (privacy, a shared chat, /admin) aren't, and a tap
// never lands on them.
const isFlash = (w) => {
  const page = new URL(w.url);
  return page.origin === self.location.origin && page.pathname === "/";
};

// A tap brings an open Flash to the front, which is told the page to show; with none open, it opens one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = flashPage(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find(isFlash);
      if (!open) return self.clients.openWindow(url);
      open.postMessage({ type: "flash:open", url });
      return open.focus();
    }),
  );
});
