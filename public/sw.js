// Flash AI's service worker. It lets browsers install Flash as an app, and shows a short message
// instead of the browser's error page when an installed Flash opens without a connection.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flash AI</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0c10;color:#e4e4e7;font-family:system-ui,sans-serif;text-align:center">
<div><p style="font-size:20px;font-weight:600;margin:0 0 8px">You're offline</p><p style="color:#a1a1aa;margin:0 0 20px">Flash needs the internet. Reconnect and try again.</p>
<button onclick="location.reload()" style="background:#5b8cf6;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-size:15px">Try again</button></div>`;

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
  );
});
