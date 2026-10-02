"use client";

import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ENGINE_LABELS } from "@/lib/types";
import type { UIMessage } from "@/lib/store";
import { AppPreview } from "./AppPreview";

const EXTENSIONS: Record<string, string> = {
  csv: "csv",
  markdown: "md",
  md: "md",
  json: "json",
  python: "py",
  py: "py",
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  html: "html",
  css: "css",
  sql: "sql",
  bash: "sh",
  sh: "sh",
};
const MIME: Record<string, string> = { csv: "text/csv", md: "text/markdown", json: "application/json", html: "text/html" };
const DOWNLOAD_LABEL: Record<string, string> = { csv: "Download spreadsheet (.csv)", md: "Download document (.md)" };

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const ext = EXTENSIONS[lang] ?? "txt";
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: MIME[ext] ?? "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `flash-${Date.now()}.${ext}` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="not-prose my-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
        <span>{lang || "text"}</span>
        <span className="flex gap-3">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="hover:text-zinc-100"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={download} className="text-indigo-400 hover:text-indigo-300">
            {DOWNLOAD_LABEL[ext] ?? "Download"}
          </button>
        </span>
      </div>
      <pre className="max-h-[480px] overflow-auto p-3 font-mono text-sm leading-relaxed text-zinc-200">{text}</pre>
    </div>
  );
}

const markdownComponents: Components = {
  pre({ children }) {
    const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
    const lang = /language-([\w+#-]+)/.exec(child?.props.className ?? "")?.[1]?.toLowerCase() ?? "";
    const text = String(child?.props.children ?? "").replace(/\n$/, "");
    return <CodeBlock lang={lang} text={text} />;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

function plainText(m: UIMessage): string {
  return [m.content, m.after].filter(Boolean).join("\n\n").trim();
}

function Actions({ m, onRetry }: { m: UIMessage; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = plainText(m);
  if (m.pending || (!text && !onRetry)) return null;
  const btn = "rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-200";
  return (
    <div className="mt-2 flex gap-1 text-xs text-zinc-500">
      {text && (
        <button
          className={btn}
          onClick={() => {
            navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      {onRetry && (
        <button className={btn} onClick={onRetry}>
          ↻ Retry
        </button>
      )}
    </div>
  );
}

export function Message({
  m,
  onRetry,
  onBuyCredits,
  onPublished,
}: {
  m: UIMessage;
  onRetry?: () => void;
  onBuyCredits?: () => void;
  onPublished?: (slug: string) => void;
}) {
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
            {m.model && (
              <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-indigo-200" title={`Picked because: ${m.modelWhy ?? ""}`}>
                {m.model}
              </span>
            )}
            {!!m.cost && <span className="text-zinc-500">⚡ {m.cost} credits</span>}
            {m.free && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300">free</span>}
          </div>
        )}
        {m.free && !m.pending && (
          <p className="mb-1 text-xs text-zinc-500">
            You&apos;re out of credits, so a free open-source model answered.{" "}
            {onBuyCredits && (
              <button onClick={onBuyCredits} className="text-indigo-300 underline-offset-2 hover:underline">
                Get credits for the best models
              </button>
            )}
          </p>
        )}
        {m.content && (
          <div className="prose prose-invert max-w-none break-words prose-p:my-2 prose-pre:bg-zinc-900">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {m.content}
            </ReactMarkdown>
          </div>
        )}
        {m.status && (
          <div className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400" />
            {m.status}
          </div>
        )}
        {m.pending && !m.status && !m.content && !m.images?.length && (
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
        {m.app && <AppPreview app={m.app} onPublished={onPublished} />}
        {m.after?.trim() && (
          <div className="prose prose-invert mt-3 max-w-none break-words prose-p:my-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {m.after}
            </ReactMarkdown>
          </div>
        )}
        {m.videos?.map((v, i) => (
          <figure key={i} className="mt-2">
            <video controls src={v.url} className="w-full max-w-2xl rounded-xl border border-zinc-800" />
            <figcaption className="mt-1 flex gap-3 text-xs text-zinc-500">
              <span className="line-clamp-2">{v.prompt}</span>
              <a href={v.url} download="flash-video.mp4" className="shrink-0 text-indigo-400 hover:underline">
                Download
              </a>
            </figcaption>
          </figure>
        ))}
        {m.audio && (
          <div className="mt-2 flex items-center gap-3">
            <audio controls src={m.audio} className="w-full max-w-md" />
            <a href={m.audio} download={m.audioLabel ?? "flash-audio.mp3"} className="text-xs text-indigo-400 hover:underline">
              Download
            </a>
          </div>
        )}
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
        {m.stopped && <p className="mt-2 text-xs text-zinc-500">Stopped.</p>}
        {m.error && m.errorCode === "out_of_credits" ? (
          <div className="mt-2 rounded-xl border border-indigo-500/40 bg-gradient-to-br from-indigo-500/15 to-fuchsia-500/10 p-4 text-sm">
            <p className="font-medium text-zinc-100">You&apos;re out of credits for this one</p>
            <p className="mt-1 text-zinc-300">
              {m.error} Pick a plan or top up to keep going, or wait for your free monthly credits.
            </p>
            {onBuyCredits && (
              <button
                onClick={onBuyCredits}
                className="mt-3 rounded-lg bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
              >
                Get more credits
              </button>
            )}
          </div>
        ) : (
          m.error && (
            <div className="mt-2 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {m.error}
            </div>
          )
        )}
        <Actions m={m} onRetry={onRetry} />
      </div>
    </div>
  );
}
