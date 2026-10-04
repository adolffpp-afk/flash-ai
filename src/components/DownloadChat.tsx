"use client";

import { createElement, useState } from "react";
import type { UIMessage } from "@/lib/store";
import { chatDocument, chatFileName } from "@/lib/chat-export";

// Pictures are put inside the page so it works offline; past this much, later ones become captions.
const MAX_PICTURE_BYTES = 40 * 1024 * 1024;

async function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Downloads the chat as a web page with its pictures, to keep, print to PDF or send on. */
export function DownloadChat({ project, disabled }: { project: { name: string; messages?: UIMessage[] }; disabled?: boolean }) {
  const [working, setWorking] = useState(false);

  async function download() {
    setWorking(true);
    try {
      const [{ renderToStaticMarkup }, { default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
        import("react-dom/server"),
        import("react-markdown"),
        import("remark-gfm"),
      ]);
      const messages = project.messages ?? [];
      const pictures = new Map<string, string>();
      let bytes = 0;
      for (const url of messages.flatMap((m) => (m.images ?? []).map((i) => i.url)).filter(Boolean)) {
        if (pictures.has(url) || bytes > MAX_PICTURE_BYTES) continue;
        try {
          const blob = await (await fetch(url)).blob();
          if (!blob.type.startsWith("image/")) continue;
          bytes += blob.size;
          pictures.set(url, await asDataUrl(blob));
        } catch {
          // Left as a caption.
        }
      }
      const html = chatDocument(project.name, messages, {
        markdown: (text) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text)),
        picture: (url) => pictures.get(url) ?? null,
        link: (url) => new URL(url, window.location.origin).href,
        date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      link.download = chatFileName(project.name);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } finally {
      setWorking(false);
    }
  }

  return (
    <button
      onClick={download}
      disabled={disabled || working}
      title="Download this chat as a page you can keep, print or send"
      aria-label="Download this chat"
      className="inline-flex h-[26px] w-[30px] shrink-0 items-center justify-center rounded-full border border-white/10 text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40"
    >
      {working ? (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" aria-hidden />
      ) : (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3v12 M7 10l5 5 5-5 M5 19h14" />
        </svg>
      )}
    </button>
  );
}
