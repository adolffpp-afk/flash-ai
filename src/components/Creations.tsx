"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { msg, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/use-t";

type FileSummary = { id: string; mime: string; name: string; size: number; created_at: number };
type Kind = "all" | "image" | "video" | "audio";

const TABS: { kind: Kind; label: string }[] = [
  { kind: "all", label: msg("All") },
  { kind: "image", label: msg("Images") },
  { kind: "video", label: msg("Videos") },
  { kind: "audio", label: msg("Audio") },
];

const sizeLabel = (bytes: number, t: Translate, locale: string) =>
  bytes >= 1e6
    ? t("{size} MB", { size: (bytes / 1e6).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) })
    : t("{size} KB", { size: Math.max(1, Math.round(bytes / 1e3)).toLocaleString(locale, { useGrouping: false }) });
const dateLabel = (time: number, locale: string) => new Date(time).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });

/** My creations: every picture, video and sound Flash made, to view, download or delete. */
export function Creations({ start = "all", onClose, onUseImage }: { start?: Kind; onClose: () => void; onUseImage?: (url: string) => void }) {
  const t = useT();
  const [kind, setKind] = useState<Kind>(start);
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The English phrase, translated where it's shown.
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (k: Kind, before?: number) => {
    const q = new URLSearchParams();
    if (k !== "all") q.set("kind", k);
    if (before) q.set("before", String(before));
    try {
      const { files: page } = await api<{ files: FileSummary[] }>(`/api/files?${q}`);
      setFiles((list) => (before ? [...(list ?? []), ...page] : page));
      setMore(page.length === 24);
    } catch {
      setError(msg("Couldn't load your creations. Please try again."));
      setFiles((list) => list ?? []);
    }
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    api<{ files: FileSummary[] }>(start === "all" ? "/api/files" : `/api/files?kind=${start}`)
      .then(({ files: page }) => {
        setFiles(page);
        setMore(page.length === 24);
      })
      .catch(() => {
        setError(msg("Couldn't load your creations. Please try again."));
        setFiles([]);
      });
    // Only the tab it opened on; picking another tab loads that one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(k: Kind) {
    setKind(k);
    setFiles(null);
    setConfirming(null);
    load(k);
  }

  async function remove(id: string) {
    try {
      await api(`/api/files/${id}`, { method: "DELETE" });
      setFiles((list) => list?.filter((f) => f.id !== id) ?? null);
    } catch {
      setError(msg("Couldn't delete that. Please try again."));
    }
    setConfirming(null);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("My creations")}
        className="flex h-full w-full max-w-5xl flex-col bg-zinc-950 text-zinc-100 sm:h-[85vh] sm:rounded-2xl sm:border sm:border-white/8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/6 px-5 py-4">
          <h2 className="shrink-0 whitespace-nowrap text-lg font-medium tracking-tight">{t("My creations")}</h2>
          <div className="ml-1 flex min-w-0 gap-1 overflow-x-auto" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab.kind}
                role="tab"
                aria-selected={kind === tab.kind}
                onClick={() => pick(tab.kind)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs transition ${
                  kind === tab.kind ? "bg-white/[0.1] text-white" : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {t(tab.label)}
              </button>
            ))}
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="ml-auto rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
            aria-label={t("Close")}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {error && <p role="alert" className="mb-3 text-sm text-red-400">{t(error)}</p>}
          {files === null ? (
            <p className="text-sm text-zinc-500">{t("Loading…")}</p>
          ) : files.length === 0 ? (
            <div className="mx-auto mt-16 max-w-sm text-center">
              <p className="text-zinc-300">{t("Nothing here yet.")}</p>
              <p className="mt-1 text-sm text-zinc-500">
                {t(
                  "Pictures, videos, music and voice-overs Flash makes for you appear here, including ones made from Claude or ChatGPT through the Flash connector.",
                )}
              </p>
            </div>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {files.map((f) => {
                  const url = `/api/files/${f.id}`;
                  return (
                    <li key={f.id} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-white/[0.02]">
                      <div className="flex aspect-square items-center justify-center bg-[repeating-conic-gradient(#18181b_0%_25%,#111113_0%_50%)] bg-[length:16px_16px]">
                        {f.mime.startsWith("image/") ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={url} alt={f.name} loading="lazy" className="h-full w-full object-contain" />
                        ) : f.mime.startsWith("video/") ? (
                          <video src={url} controls preload="metadata" playsInline className="h-full w-full bg-black object-contain" />
                        ) : (
                          <div className="flex w-full flex-col items-center gap-3 px-3">
                            <span className="text-3xl" aria-hidden>
                              🎵
                            </span>
                            <audio src={url} controls preload="none" className="w-full" />
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 px-3 py-2 text-xs">
                        <span className="min-w-0 flex-1 truncate text-zinc-400" title={f.name}>
                          {dateLabel(f.created_at, t.locale)} · {sizeLabel(f.size, t, t.locale)}
                        </span>
                        {confirming === f.id ? (
                          <>
                            <button onClick={() => remove(f.id)} className="text-red-400 hover:text-red-300">
                              {t("Delete")}
                            </button>
                            <button onClick={() => setConfirming(null)} className="text-zinc-400 hover:text-zinc-100">
                              {t("Keep")}
                            </button>
                          </>
                        ) : (
                          <>
                            {onUseImage && f.mime.startsWith("image/") && (
                              <button
                                onClick={() => onUseImage(url)}
                                className="text-primary hover:text-primary-soft"
                                aria-label={t("Edit or animate {name}", { name: f.name })}
                                title={t("Edit or animate")}
                              >
                                ✏️
                              </button>
                            )}
                            <a href={url} download={f.name} className="text-primary hover:text-primary-soft">
                              {t("Download")}
                            </a>
                            <button
                              onClick={() => setConfirming(f.id)}
                              className="text-zinc-500 hover:text-red-400"
                              aria-label={t("Delete {name}", { name: f.name })}
                            >
                              🗑
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {confirming && (
                <p className="mt-3 text-xs text-zinc-500">{t("Deleting removes it everywhere, including from chats and shared links.")}</p>
              )}
              {more && (
                <button
                  onClick={() => load(kind, files.at(-1)?.created_at)}
                  className="mx-auto mt-5 block rounded-full border border-white/10 px-4 py-2 text-sm text-zinc-300 transition hover:bg-white/[0.05]"
                >
                  {t("Show more")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
