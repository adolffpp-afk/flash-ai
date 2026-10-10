"use client";

import { useEffect, useRef, useState } from "react";
import { api, type UIMessage } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { PROJECT_TOO_LARGE } from "@/lib/project-size";

/**
 * Makes a read-only link to the chat as it is now, with Copy and Stop sharing. The project is
 * saved first, so the link shows the latest messages.
 */
export function ShareDialog({
  project,
  onClose,
}: {
  project: { id: string; name: string; messages?: UIMessage[] };
  onClose: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [stopped, setStopped] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    (async () => {
      try {
        const messages = (project.messages ?? []).map((m) => ({ ...m, pending: undefined, status: undefined }));
        await api(`/api/projects/${project.id}`, { method: "PUT", json: { name: project.name, messages } });
        const res = await api<{ url: string }>(`/api/projects/${project.id}/share`, { method: "POST" });
        setUrl(res.url);
      } catch (err) {
        // Over 4.5 MB, Vercel refuses the save before Flash can say why.
        setError((err as { status?: number } | null)?.status === 413 ? t(PROJECT_TOO_LARGE) : err instanceof Error ? err.message : t("Couldn't make a link. Please try again."));
      }
    })();
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the link is selectable in the box.
    }
  }

  async function stop() {
    try {
      await api(`/api/projects/${project.id}/share`, { method: "DELETE" });
      setStopped(true);
    } catch {
      setError(t("Couldn't stop sharing. Please try again."));
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Share this chat")}
        className="w-full max-w-md rounded-t-2xl border border-white/8 bg-zinc-950 p-6 text-zinc-100 sm:rounded-2xl sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <h2 className="text-lg font-medium tracking-tight">{t("Share this chat")}</h2>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>
        {stopped ? (
          <p className="text-sm text-zinc-300">{t("Sharing stopped. Links to this chat no longer work.")}</p>
        ) : (
          <>
            <p className="text-sm text-zinc-400">
              {t("Anyone with the link can see this chat as it is now, including its pictures and videos. Messages you send later aren't shared.")}
            </p>
            {error ? (
              <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>
            ) : (
              <div className="mt-4 flex gap-2">
                <input
                  readOnly
                  value={url || t("Making your link…")}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label={t("Share link")}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70"
                />
                <button
                  onClick={copy}
                  disabled={!url}
                  className="h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
                >
                  {copied ? t("Copied") : t("Copy link")}
                </button>
              </div>
            )}
            {url && (
              <button onClick={stop} className="mt-4 text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">
                {t("Stop sharing this chat")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
