/*
 * Open in a new tab: the app shown in Flash's preview, in a tab of its own (at /preview), which
 * follows along as Flash changes it. The tab asks Flash's tab for the app over a BroadcastChannel,
 * so the code never goes to the server or into the address, and works while Flash is open.
 */

export const TAB_CHANNEL = "flash-preview-tab";

export type TabMessage = { type: "want"; key: string } | { type: "show"; key: string; html: string; title: string };

const shown = new Map<string, { html: string; title: string }>();
let channel: BroadcastChannel | null = null;

function open(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(TAB_CHANNEL);
  channel.onmessage = (e: MessageEvent<TabMessage>) => {
    const data = e.data;
    if (data?.type !== "want") return;
    const app = shown.get(data.key);
    if (app) channel?.postMessage({ type: "show", key: data.key, ...app } satisfies TabMessage);
  };
  return channel;
}

/** Tells a tab showing this preview (now or later) what's in it now. */
export function shareToTab(key: string, html: string, title: string) {
  const before = shown.get(key);
  if (before && before.html === html && before.title === title) return;
  shown.set(key, { html, title });
  open()?.postMessage({ type: "show", key, html, title } satisfies TabMessage);
}

/** Opens the tab for this preview; false when the browser can't. */
export function openTab(key: string, html: string, title: string): boolean {
  if (!open()) return false;
  shareToTab(key, html, title);
  return Boolean(window.open(`/preview#${encodeURIComponent(key)}`, "_blank"));
}
