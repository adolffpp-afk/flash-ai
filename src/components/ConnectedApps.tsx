"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import { SITE_URL } from "@/app/site";
import { useT } from "@/lib/use-t";

type App = { id: string; name: string; since: number };

const CONNECTOR_URL = `${SITE_URL}/mcp`;

/** The Flash connector's address to add in Claude, ChatGPT and others, and the apps already connected. */
export function ConnectedApps() {
  const t = useT();
  const [apps, setApps] = useState<App[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<{ apps: App[] }>("/api/connections")
      .then((r) => setApps(r.apps))
      .catch(() => setApps([]));
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(CONNECTOR_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the address is selectable in the box.
    }
  }

  async function disconnect(id: string) {
    await api("/api/connections", { method: "DELETE", json: { id } }).catch(() => {});
    setApps((list) => list?.filter((a) => a.id !== id) ?? null);
  }

  return (
    <div className="rounded-xl border border-zinc-800 p-4">
      <p className="text-sm text-zinc-300">
        {t(
          "Use Flash's images, videos, music and voice from Claude, ChatGPT and other AI apps. Add Flash as a custom connector with this address, then sign in. It spends your credits at the same prices.",
        )}{" "}
        <a href="/connector" className="text-primary underline-offset-2 hover:underline">
          {t("How to connect")}
        </a>
      </p>
      <div className="mt-3 flex gap-2">
        <input
          readOnly
          value={CONNECTOR_URL}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={t("Flash connector address")}
          className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
        />
        <button
          onClick={copy}
          className="h-9 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110"
        >
          {copied ? t("Copied") : t("Copy")}
        </button>
      </div>
      {apps && apps.length > 0 && (
        <ul className="mt-3 divide-y divide-white/6 text-sm">
          {apps.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate text-zinc-200">{a.name}</span>
              <span className="text-xs text-zinc-500">
                {t("since {date}", { date: new Date(a.since).toLocaleDateString(t.locale, { month: "short", day: "numeric" }) })}
              </span>
              <button onClick={() => disconnect(a.id)} className="text-xs text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline">
                {t("Disconnect")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
