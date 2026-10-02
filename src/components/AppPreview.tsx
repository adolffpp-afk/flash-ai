"use client";

import { useEffect, useState } from "react";
import type { BuiltApp } from "@/lib/types";

// No allow-same-origin: generated code can't read Flash's storage or cookies.
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flash-app";
}

export function AppPreview({ app }: { app: BuiltApp }) {
  const [view, setView] = useState<"preview" | "code">("preview");
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);

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
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        <span className="flex gap-1" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        </span>
        <span className="ml-1 min-w-0 flex-1 truncate font-medium text-zinc-200">{app.title}</span>
        <div className="flex shrink-0 items-center gap-1">
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
          <button className={btn} onClick={() => setFull((f) => !f)}>
            {full ? "Exit full screen" : "Full screen"}
          </button>
          <button className={`${btn} text-indigo-400`} onClick={download}>
            Download
          </button>
        </div>
      </div>
      {view === "preview" ? (
        <iframe
          key={reload}
          title={app.title}
          srcDoc={app.html}
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
