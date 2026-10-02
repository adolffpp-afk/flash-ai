"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ENGINE_LABELS } from "@/lib/types";
import type { UIMessage } from "@/lib/store";

export function Message({ m }: { m: UIMessage }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-white">
          {m.attachmentName && (
            <div className="mb-1 text-xs text-indigo-100">📎 {m.attachmentName}</div>
          )}
          <p className="whitespace-pre-wrap break-words">{m.content}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-pink-500 text-sm">
        ⚡
      </div>
      <div className="min-w-0 flex-1">
        {m.engine && (
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">
              {ENGINE_LABELS[m.engine]}
            </span>
            <span>{m.reason}</span>
            {m.demo && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">demo</span>}
          </div>
        )}
        {m.content && (
          <div className="prose prose-invert max-w-none break-words prose-p:my-2 prose-pre:bg-zinc-900">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
          </div>
        )}
        {m.pending && !m.content && !m.images?.length && (
          <div className="flex gap-1 py-3" aria-label="Thinking">
            <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:150ms]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:300ms]" />
          </div>
        )}
        {m.images?.map((img, i) =>
          img.url ? (
            <figure key={i} className="mt-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.prompt} className="max-h-[512px] rounded-xl border border-zinc-800" />
              <figcaption className="mt-1 flex gap-3 text-xs text-zinc-500">
                <span className="line-clamp-2">{img.prompt}</span>
                <a href={img.url} download="flash-image.png" className="shrink-0 text-indigo-400 hover:underline">
                  Download
                </a>
              </figcaption>
            </figure>
          ) : (
            <p key={i} className="mt-2 text-xs text-zinc-500">Image not kept (browser storage was full).</p>
          ),
        )}
        {m.audio && <audio controls src={m.audio} className="mt-2 w-full max-w-md" />}
        {m.sources && m.sources.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {m.sources.map((s, i) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="max-w-[16rem] truncate rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:border-indigo-500"
              >
                {i + 1}. {s.title || new URL(s.url).hostname}
              </a>
            ))}
          </div>
        )}
        {m.error && (
          <div className="mt-2 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
            {m.error}
          </div>
        )}
      </div>
    </div>
  );
}
