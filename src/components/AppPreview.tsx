"use client";

import { useEffect, useMemo, useState } from "react";
import type { BuiltApp } from "@/lib/types";
import { api } from "@/lib/store";
import { flashDbShim, injectHead } from "@/lib/flashdb-shim";

// No allow-same-origin: generated code can't read Flash's storage or cookies.
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flash-app";
}

export function AppPreview({
  app,
  onPublished,
}: {
  app: BuiltApp & { slug?: string };
  onPublished?: (slug: string) => void;
}) {
  const [view, setView] = useState<"preview" | "code">("preview");
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState("");
  const [publishError, setPublishError] = useState("");
  const [copied, setCopied] = useState(false);
  // The preview gets an in-memory flashDB, so trying an app never touches the published app's data.
  const previewHtml = useMemo(() => injectHead(app.html, flashDbShim(null)), [app.html]);
  const link = app.slug && typeof window !== "undefined" ? `${window.location.origin}/p/${app.slug}` : "";

  async function publish() {
    setPublishing(true);
    setPublishError("");
    try {
      const res = await api<{ slug: string }>("/api/sites", {
        method: "POST",
        json: { html: app.html, title: app.title, slug: app.slug },
      });
      onPublished?.(res.slug);
      setPublished(res.slug);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Couldn't publish.");
    } finally {
      setPublishing(false);
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([app.html], { type: "text/html" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${slug(app.title)}.html` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const btn = "rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-100";
  return (
    <div
      className={
        full
          ? "fixed inset-0 z-50 flex flex-col bg-zinc-950"
          : "mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <span className="flex gap-1" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        </span>
        <span className="ml-1 min-w-0 flex-1 truncate font-medium text-zinc-200">{app.title}</span>
        {/* On a phone the buttons wrap below the title and show icons only. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div className="mr-1 flex rounded-md border border-zinc-800" role="tablist">
            {(["preview", "code"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`px-2 py-1 capitalize ${view === v ? "bg-zinc-800 text-zinc-100" : ""}`}
              >
                {v}
              </button>
            ))}
          </div>
          <button className={btn} onClick={() => setReload((r) => r + 1)} aria-label="Restart app" title="Restart">
            ↻
          </button>
          <button className={btn} onClick={() => setFull((f) => !f)} aria-label={full ? "Exit full screen" : "Full screen"}>
            <span className="sm:hidden" aria-hidden>
              {full ? "✕" : "⤢"}
            </span>
            <span className="hidden sm:inline">{full ? "Exit full screen" : "Full screen"}</span>
          </button>
          <button className={`${btn} text-indigo-400`} onClick={download} aria-label="Download">
            <span className="sm:hidden" aria-hidden>
              ⬇
            </span>
            <span className="hidden sm:inline">Download</span>
          </button>
          {onPublished && (
            <button
              className="ml-1 rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-50"
              onClick={publish}
              disabled={publishing}
            >
              {publishing ? "Publishing…" : app.slug ? (published === app.slug ? "Published ✓" : "Update") : "Publish"}
            </button>
          )}
        </div>
      </div>
      {(link || publishError) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs">
          {publishError ? (
            <span className="text-red-300">{publishError}</span>
          ) : (
            <>
              <span className="text-emerald-300">Live at</span>
              <a href={link} target="_blank" rel="noreferrer" className="min-w-0 truncate text-indigo-300 hover:underline">
                {link}
              </a>
              <button className={btn} onClick={copyLink}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </>
          )}
        </div>
      )}
      {view === "preview" ? (
        <iframe
          key={reload}
          title={app.title}
          srcDoc={previewHtml}
          sandbox={SANDBOX}
          className={`w-full bg-white ${full ? "flex-1" : app.kind === "slides" ? "aspect-video" : "h-[560px]"}`}
        />
      ) : (
        <pre
          className={`overflow-auto p-3 font-mono text-xs leading-relaxed text-zinc-300 ${full ? "flex-1" : "h-[560px]"}`}
        >
          {app.html}
        </pre>
      )}
    </div>
  );
}
