"use client";

import { useEffect, useMemo, useState } from "react";
import { flashDbShim, injectHead } from "@/lib/flashdb-shim";
import { TAB_CHANNEL, type TabMessage } from "@/lib/preview-tab";
import { useT } from "@/lib/use-t";

// The same frame as the preview in Flash: no allow-same-origin, so the app can't read Flash's storage or cookies.
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";
// How long Flash's tab has to answer before the page says to open it.
const WAIT_MS = 2500;

/** An app from Flash's preview in a tab of its own, following along as Flash changes it (see preview-tab). */
export function PreviewTab() {
  const t = useT();
  const [app, setApp] = useState<{ html: string; title: string } | null>(null);
  const [lost, setLost] = useState(false);
  const html = useMemo(() => (app ? injectHead(app.html, flashDbShim(null)) : ""), [app]);

  useEffect(() => {
    const key = decodeURIComponent(window.location.hash.slice(1));
    if (!key || typeof BroadcastChannel === "undefined") {
      const timer = setTimeout(() => setLost(true), 0);
      return () => clearTimeout(timer);
    }
    const channel = new BroadcastChannel(TAB_CHANNEL);
    channel.onmessage = (e: MessageEvent<TabMessage>) => {
      const data = e.data;
      if (data?.type !== "show" || data.key !== key || typeof data.html !== "string") return;
      setApp((now) => (now && now.html === data.html && now.title === data.title ? now : { html: data.html, title: String(data.title || "") }));
      setLost(false);
    };
    channel.postMessage({ type: "want", key } satisfies TabMessage);
    const timer = setTimeout(() => setLost(true), WAIT_MS);
    return () => {
      clearTimeout(timer);
      channel.close();
    };
  }, []);

  useEffect(() => {
    if (app?.title) document.title = app.title;
  }, [app?.title]);

  if (app) return <iframe title={app.title} srcDoc={html} sandbox={SANDBOX} className="block h-full w-full border-0 bg-white" />;
  return (
    <main className="flex h-full items-center justify-center bg-zinc-950 px-6 text-center text-sm text-zinc-400">
      {lost ? (
        <p className="max-w-sm">{t("Keep Flash open in another tab to see your app here. This tab updates by itself each time Flash changes it.")}</p>
      ) : (
        <span className="h-6 w-6 motion-safe:animate-spin rounded-full border-2 border-zinc-600 border-t-gold" aria-hidden />
      )}
    </main>
  );
}
