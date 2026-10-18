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

// An account id, as an alert's page names it (as=, see pagePath in push.ts) and Flash's tabs do.
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;

// The account an alert's page is for, or "" when it names none.
function accountOf(url) {
  try {
    const named = new URL(typeof url === "string" ? url : "", self.location.origin).searchParams.get("as") || "";
    return ACCOUNT.test(named) ? named : "";
  } catch {
    return "";
  }
}

// Whether the alert's account (the browser may be signed in to several, see account-pin.ts) still
// gets alerts here, asked of Flash, as that account, before the alert shows its words: one may have
// waited at the push service (a phone or laptop that was off) through a log out, "Log out of all
// devices", a password change or the sign-in ending. "on": its sign-in here is live and turned them
// on; "named": the same, with other accounts signed in here too, so the alert says whose it is.
// "off": it isn't; "nobody": no account at all is signed in here. Either drops this browser's
// subscription once no account signed in here gets alerts by it, so nothing else waiting for it
// arrives (Flash makes a new one when an account signs in here again and wants alerts). "unknown"
// (no answer, or an alert that names no account) keeps it. ended: the push itself says that
// account's sign-in ended (clearScreens in push.ts), with nothing to ask: only Flash can send one
// this browser can read, and nothing else would come to clear the screen if Flash didn't answer.
// keep: another account still gets alerts here, so the subscription they come by stays.
async function stillOn(ended, account, keep) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (ended) {
      if (!keep) await sub?.unsubscribe().catch(() => false);
      return account ? "off" : "nobody";
    }
    if (!sub) return "off";
    if (!account) return "unknown";
    const res = await fetch(`/api/push?e=${await addressHash(sub)}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Flash-Account": account },
      ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {}),
    });
    if (res.status === 401) {
      await sub.unsubscribe().catch(() => false);
      return "nobody";
    }
    if (!res.ok) return "unknown";
    const answer = await res.json();
    if (answer.on === true) return answer.several === true ? "named" : "on";
    if (answer.here !== true) await sub.unsubscribe().catch(() => false);
    return "off";
  } catch {
    return ended ? "off" : "unknown";
  }
}

// Flash itself is its home page; its other pages (privacy, a shared chat, /admin) aren't, and a tap
// never lands on them.
const isFlash = (w) => {
  const page = new URL(w.url);
  return page.origin === self.location.origin && page.pathname === "/";
};

// The tag of an alert whose words are held back: each takes the last one's place, so they never pile up.
const HIDDEN = "flash-hidden";

// Alerts show one at a time, in the order they arrived, each with the closing it does, so two that
// arrive together (a laptop waking with two of one run's alerts) never close each other and the later
// one stays, whichever of their checks Flash answers first.
let showing = Promise.resolve();

// An alert: {title, body, who, url, tag}, already in the account's language, its url naming the
// account (as=) and who the line that names it ("For ana@example.com"), put first when other accounts
// are signed in here too; or {ended: true, as, keep} once the sign-in of that account that turned
// alerts on here has ended. A later one with the same tag replaces it and still alerts; one with
// none shows on its own.
// Browsers require every push to show something, so one that can't be read, or whose account's
// sign-in here isn't live, shows Flash's name only. When that sign-in has ended, the alerts that
// account already showed here go too (every alert, once nobody is signed in here), so the next
// person on a shared computer doesn't see them; the other accounts' stay. Safari keeps a tag but
// never lets it replace anything (webkit.org/b/258922), so once the new alert shows, any earlier one
// with its tag still there is closed; elsewhere the browser has replaced it already, and there's none.
self.addEventListener("push", (event) => {
  const text = (value) => (typeof value === "string" ? value : "");
  const show = async () => {
    let alert = {};
    try {
      alert = (event.data && event.data.json()) || {};
    } catch {}
    const ended = alert.ended === true;
    const account = ended ? (ACCOUNT.test(text(alert.as)) ? alert.as : "") : accountOf(alert.url);
    // Asked at once, while its place in line is taken now, before any answer comes back.
    const asked = stillOn(ended, account, ended && alert.keep === true);
    const turn = showing.then(async () => {
      const on = await asked;
      if (on === "named") alert.body = [text(alert.who), text(alert.body)].filter(Boolean).join("\n");
      else if (on !== "on") alert = { tag: HIDDEN };
      if (on === "off" || on === "nobody") {
        for (const shown of await self.registration.getNotifications().catch(() => [])) {
          if (shown.tag !== HIDDEN && (on === "nobody" || accountOf(shown.data && shown.data.url) === account)) shown.close();
        }
      }
      const tag = text(alert.tag);
      // Tells this alert from the earlier ones with its tag.
      const id = `${Date.now()}-${Math.random()}`;
      await self.registration.showNotification(text(alert.title) || "Flash ∞ AI", {
        body: text(alert.body),
        icon: "/app-icon/192?v=3",
        data: { url: flashPage(alert.url), id },
        ...(tag ? { tag, renotify: tag !== HIDDEN } : {}),
        // One that only says a sign-in ended carries no alert of anyone's, so it makes no sound and
        // doesn't buzz. It still shows, as every push must, also to someone else signed in here.
        ...(ended ? { silent: true } : {}),
      });
      if (!tag) return;
      for (const shown of await self.registration.getNotifications().catch(() => [])) {
        if (shown.tag === tag && shown.data && shown.data.id && shown.data.id !== id) shown.close();
      }
    });
    showing = turn.catch(() => {});
    await turn;
  };
  // A dot on the installed app's icon until Flash is opened again (it clears it); none while Flash is
  // on the screen and in front, where the person sees the alert come in.
  const badge = async () => {
    if (!self.navigator.setAppBadge) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((w) => isFlash(w) && w.visibilityState === "visible" && w.focused)) return;
    await self.navigator.setAppBadge();
  };
  event.waitUntil(Promise.all([show(), badge().catch(() => {})]));
});

// A tap brings an open Flash to the front, which is told the page to show: a tab showing another
// account than the alert's goes on as it (onAlertTapped in src/lib/push.ts), since a tab's address
// doesn't say which account it shows. With none open, it opens one.
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
