"use client";

import { createElement, isValidElement, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ENGINE_LABELS } from "@/lib/types";
import type { UIMessage } from "@/lib/store";
import { AppPreview } from "./AppPreview";
import { speakable } from "@/lib/speech";
import { BoltIcon, LogoMark } from "@/app/brand";
import { wordDocument, wordFileName } from "@/lib/word-export";
import { csvRows, excelWorkbook, tablesIn } from "@/lib/excel-export";
import { slidesDeck } from "@/lib/slides-export";
import { answerDocument, documentText } from "@/lib/chat-export";
import { postText, type Post } from "@/lib/post-pack";
import { readAloudVoice } from "@/lib/device-settings";

export type Reshape = "tall" | "square" | "wide";
const RESHAPES: [Reshape, string][] = [
  ["tall", "Tall"],
  ["square", "Square"],
  ["wide", "Wide"],
];

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
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOWNLOAD_LABEL: Record<string, string> = { csv: "Download spreadsheet (.csv)", md: "Download document (.md)" };

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const ext = EXTENSIONS[lang] ?? "txt";
  const downloadText = () => {
    const url = URL.createObjectURL(new Blob([text], { type: MIME[ext] ?? "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `flash-${Date.now()}.${ext}` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="not-prose my-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
        <span>{lang || "text"}</span>
        <span className="flex flex-wrap justify-end gap-x-3 gap-y-1">
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
          <button onClick={downloadText} className="text-primary hover:text-primary-soft">
            {DOWNLOAD_LABEL[ext] ?? "Download"}
          </button>
          {ext === "csv" && (
            // The same rows as an Excel workbook, with amounts as real numbers.
            <button
              onClick={() => download(excelWorkbook([{ name: "Sheet1", rows: csvRows(text) }]), XLSX_TYPE, `flash-${Date.now()}.xlsx`)}
              className="text-primary hover:text-primary-soft"
            >
              Excel (.xlsx)
            </button>
          )}
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

/** A download name for an image: data URLs carry their type, and saved files are named by the server. */
function imageFileName(url: string): string {
  const type = /^data:image\/([\w+.-]+)/.exec(url)?.[1];
  if (!type) return "";
  return `flash-image.${type === "jpeg" ? "jpg" : type === "svg+xml" ? "svg" : type}`;
}

function plainText(m: UIMessage): string {
  return [m.content, m.after].filter(Boolean).join("\n\n").trim();
}

function download(bytes: Uint8Array, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads a reply as a Word document, made in the browser. */
const saveAsWord = (text: string) =>
  download(wordDocument(text), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", wordFileName(text));

/**
 * Opens the browser's print window for a reply, laid out as a clean page: "Save as PDF" there
 * makes the PDF, named after the reply's first line.
 */
async function saveAsPdf(text: string) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text));
  const date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const frame = Object.assign(document.createElement("iframe"), {
    srcdoc: answerDocument(wordFileName(text).replace(/\.docx$/, ""), html, date),
    title: "Print",
  });
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // The print window has closed by the time print() returns in most browsers.
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

/** Downloads a reply's tables as an Excel workbook, one sheet per table. */
const saveAsExcel = (text: string) =>
  download(
    excelWorkbook(tablesIn(text)),
    XLSX_TYPE,
    wordFileName(text).replace(/\.docx$/, ".xlsx"),
  );

/** Downloads a reply as a PowerPoint deck: a title slide, then a slide per heading. */
const saveAsSlides = (text: string) => {
  const name = wordFileName(text).replace(/\.docx$/, "");
  const date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  download(slidesDeck(text, name, `Made with Flash AI · ${date}`), "application/vnd.openxmlformats-officedocument.presentationml.presentation", `${name}.pptx`);
};

// Answers with headings or lists make a deck; a few plain sentences don't.
const hasStructure = (text: string) => /^(#{1,3}\s|\s*[-*+]\s|\s*\d+[.)]\s|\|)/m.test(text);

/** Reads a reply aloud with the device's own voice, which is free and needs no credits. */
function ReadAloud({ text, className }: { text: string; className: string }) {
  const [speaking, setSpeaking] = useState(false);
  // Stop talking when the message leaves the screen (a new project, sign-out).
  useEffect(() => () => void (speaking && window.speechSynthesis?.cancel()), [speaking]);
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return (
    <button
      className={className}
      aria-pressed={speaking}
      onClick={() => {
        const synth = window.speechSynthesis;
        synth.cancel();
        if (speaking) return setSpeaking(false);
        const say = new SpeechSynthesisUtterance(speakable(text));
        // The voice and speed picked in Settings > General.
        const { voice, rate } = readAloudVoice();
        if (voice) say.voice = voice;
        say.rate = rate;
        say.lang = voice?.lang || navigator.language || "en-US";
        say.onend = say.onerror = () => setSpeaking(false);
        synth.speak(say);
        setSpeaking(true);
      }}
    >
      {speaking ? "■ Stop reading" : "🔊 Read aloud"}
    </button>
  );
}

/** A social post pack's Copy buttons: each network's caption with its hashtags, ready to paste. */
function PostCopies({ posts }: { posts: Post[] }) {
  const [copied, setCopied] = useState("");
  const copy = (post: Post) => {
    navigator.clipboard
      ?.writeText(postText(post))
      .then(() => {
        setCopied(post.platform);
        setTimeout(() => setCopied((c) => (c === post.platform ? "" : c)), 1500);
      })
      .catch(() => setCopied(""));
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs" aria-label="Copy a post">
      <span className="text-zinc-500">Copy the post for</span>
      {posts.map((p) => (
        <button
          key={p.platform}
          onClick={() => copy(p)}
          className="rounded-full border border-white/10 px-2.5 py-0.5 text-zinc-300 transition hover:border-primary/40 hover:text-primary-soft"
          title={`Copy the ${p.platform} caption and hashtags`}
        >
          {copied === p.platform ? "Copied ✓" : p.platform}
        </button>
      ))}
    </div>
  );
}

function Actions({ m, onRetry }: { m: UIMessage; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = plainText(m);
  const doc = documentText(text);
  if (m.pending || (!text && !onRetry)) return null;
  const btn = "rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-200";
  return (
    <div className="mt-2 flex flex-wrap gap-1 text-xs text-zinc-500">
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
      {text && <ReadAloud text={text} className={btn} />}
      {text && !m.app && (
        <button className={btn} onClick={() => saveAsWord(doc)} title="Download this answer as a Word document">
          ⬇ Word
        </button>
      )}
      {text && !m.app && (
        <button className={btn} onClick={() => saveAsPdf(doc)} title="Print this answer or save it as a PDF">
          ⬇ PDF
        </button>
      )}
      {text && !m.app && tablesIn(doc).length > 0 && (
        <button className={btn} onClick={() => saveAsExcel(doc)} title="Download this answer's tables as an Excel spreadsheet">
          ⬇ Excel
        </button>
      )}
      {text && !m.app && hasStructure(doc) && (
        <button className={btn} onClick={() => saveAsSlides(doc)} title="Download this answer as a PowerPoint deck">
          ⬇ PowerPoint
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

/** The user's own message, which can be edited and sent again when it is the latest one. */
function UserMessage({ m, onEdit }: { m: UIMessage; onEdit?: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [copied, setCopied] = useState(false);
  const btn = "rounded-md px-2 py-1 hover:bg-zinc-800 hover:text-zinc-200";
  if (editing && onEdit) {
    const save = () => {
      if (!draft.trim()) return;
      setEditing(false);
      if (draft.trim() !== m.content.trim()) onEdit(draft.trim());
    };
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl border border-white/10 bg-zinc-900 p-2">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") setEditing(false);
            }}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            aria-label="Edit your message"
            className="w-full resize-none bg-transparent px-2 py-1 text-zinc-100 outline-none"
          />
          <div className="flex justify-end gap-2 text-sm">
            <button onClick={() => (setEditing(false), setDraft(m.content))} className="rounded-lg px-3 py-1.5 text-zinc-300 hover:bg-white/[0.05]">
              Cancel
            </button>
            <button onClick={save} disabled={!draft.trim()} className="rounded-lg bg-brand px-3 py-1.5 font-medium text-white hover:brightness-110 disabled:opacity-40">
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary-strong px-4 py-2.5 text-white">
        {m.attachmentName && <div className="mb-1 text-xs text-white/80">📎 {m.attachmentName}</div>}
        <p className="whitespace-pre-wrap break-words">{m.content}</p>
      </div>
      {m.content && (
        <div className="mt-1 flex gap-1 text-xs text-zinc-500 transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          <button
            className={btn}
            onClick={() => {
              navigator.clipboard?.writeText(m.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {onEdit && (
            <button className={btn} onClick={() => (setDraft(m.content), setEditing(true))}>
              ✎ Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Message({
  m,
  onRetry,
  onEdit,
  onBuyCredits,
  onPublished,
  publishedEarlier,
  onUseImage,
  onReshape,
  onConfirmCost,
  paymentsOn = true,
}: {
  m: UIMessage;
  onRetry?: () => void;
  // Edits the user's latest message and asks again.
  onEdit?: (text: string) => void;
  onBuyCredits?: () => void;
  // False while plans and top-ups aren't on sale yet, so the copy doesn't offer them.
  paymentsOn?: boolean;
  onPublished?: (slug: string) => void;
  // The site an earlier version of this app in the same project was published as, so Publish updates it.
  publishedEarlier?: string;
  // Attaches a picture from this reply to the composer, to edit or animate it next.
  onUseImage?: (url: string) => void;
  // Makes this reply's picture again in another shape.
  onReshape?: (prompt: string, shape: Reshape) => void;
  // Runs a costly request after the user agrees to its price; true also stops asking on this device.
  onConfirmCost?: (always: boolean) => void;
}) {
  if (m.role === "user") return <UserMessage m={m} onEdit={onEdit} />;
  return (
    <div className="flex gap-3">
      <LogoMark size={32} className="mt-1" />
      <div className="min-w-0 flex-1">
        {m.engine && (
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">
              {ENGINE_LABELS[m.engine]}
            </span>
            <span>{m.reason}</span>
            {m.demo && <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">coming soon</span>}
            {m.model && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-primary-soft" title={`Picked because: ${m.modelWhy ?? ""}`}>
                {m.model}
              </span>
            )}
            {!!m.cost && (
              <span className="inline-flex items-center gap-1 text-zinc-500">
                <BoltIcon className="h-3 w-3 text-gold/80" /> {m.cost} credits
              </span>
            )}
            {m.free && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300">free</span>}
          </div>
        )}
        {m.free && !m.pending && (
          <p className="mb-1 text-xs text-zinc-500">
            You&apos;re out of credits, so a free open-source model answered.{" "}
            {onBuyCredits && (
              <button onClick={onBuyCredits} className="text-primary-soft underline-offset-2 hover:underline">
                {paymentsOn ? "Get credits for the best models" : "See your credits"}
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
        {m.posts && m.posts.length > 0 && <PostCopies posts={m.posts} />}
        {m.status && (
          <div role="status" className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-gold" />
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
        {/* Pictures that come together (a post pack's square and tall one) sit side by side. */}
        <div className={m.images?.some((img) => img.label) ? "flex flex-wrap items-start gap-3" : undefined}>
          {m.images?.map((img, i) =>
            img.url ? (
              <figure key={i} className="mt-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.label ?? img.prompt} className={`${img.label ? "max-h-[380px]" : "max-h-[512px]"} rounded-xl border border-zinc-800`} />
                {/* A labelled picture's caption wraps to the picture's width (w-0 min-w-full), so two fit side by side. */}
                <figcaption className={`mt-1 flex text-xs text-zinc-500 ${img.label ? "w-0 min-w-full flex-wrap gap-x-3 gap-y-0.5" : "gap-3"}`}>
                  <span className={img.label ? "text-zinc-400" : "line-clamp-2"}>{img.label ?? img.prompt}</span>
                  <a href={img.url} download={imageFileName(img.url)} className="shrink-0 whitespace-nowrap text-primary hover:underline">
                    Download
                  </a>
                  {onUseImage && (
                    <button onClick={() => onUseImage(img.url)} className="shrink-0 whitespace-nowrap text-primary hover:underline">
                      ✏️ Edit or animate
                    </button>
                  )}
                </figcaption>
                {onReshape && img.prompt && !img.label && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-zinc-500">Remake as</span>
                    {RESHAPES.map(([shape, label]) => (
                      <button
                        key={shape}
                        onClick={() => onReshape(img.prompt, shape)}
                        className="rounded-full border border-white/10 px-2.5 py-0.5 text-zinc-300 transition hover:border-primary/40 hover:text-primary-soft"
                        title={`Make this picture again, ${label.toLowerCase()}. Uses credits like a new picture.`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </figure>
            ) : (
              <p key={i} className="mt-2 text-xs text-zinc-500">Image not kept (browser storage was full).</p>
            ),
          )}
        </div>
        {m.app && <AppPreview app={m.app} onPublished={onPublished} publishedEarlier={publishedEarlier} />}
        {m.after?.trim() && (
          <div className="prose prose-invert mt-3 max-w-none break-words prose-p:my-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {m.after}
            </ReactMarkdown>
          </div>
        )}
        {m.videos?.map((v, i) => (
          <figure key={i} className="mt-2">
            <video
              controls
              src={v.url}
              // A post pack's video is tall, so it keeps its own width instead of filling a wide black box.
              className={`${m.posts ? "max-h-[480px] w-auto max-w-full" : "max-h-[512px] w-full max-w-2xl"} rounded-xl border border-zinc-800 bg-black`}
            />
            <figcaption className="mt-1 flex gap-3 text-xs text-zinc-500">
              <span className="line-clamp-2">{v.prompt}</span>
              <a href={v.url} download="flash-video.mp4" className="shrink-0 text-primary hover:underline">
                Download
              </a>
            </figcaption>
          </figure>
        ))}
        {m.audio && (
          <div className="mt-2 flex items-center gap-3">
            <audio controls src={m.audio} className="w-full max-w-md" />
            <a href={m.audio} download={m.audioLabel ?? "flash-audio.mp3"} className="text-xs text-primary hover:underline">
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
                className="max-w-[16rem] truncate rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:border-primary"
              >
                {i + 1}. {s.title || new URL(s.url).hostname}
              </a>
            ))}
          </div>
        )}
        {m.stopped && <p className="mt-2 text-xs text-zinc-500">Stopped.</p>}
        {m.error && m.errorCode === "confirm_cost" ? (
          <div role="status" className="mt-2 rounded-xl border border-primary/30 bg-primary/[0.06] p-4 text-sm">
            <p className="font-medium text-zinc-100">Check the price first</p>
            <p className="mt-1 text-zinc-300">{m.error}</p>
            {onConfirmCost ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => onConfirmCost(false)}
                  className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
                >
                  Go ahead
                </button>
                <button onClick={() => onConfirmCost(true)} className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline">
                  Go ahead, and don&apos;t ask again
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">Not made. Nothing was charged.</p>
            )}
          </div>
        ) : m.error && m.errorCode === "out_of_credits" ? (
          <div role="status" className="mt-2 rounded-xl border border-gold/40 bg-gradient-to-br from-gold/15 to-primary/10 p-4 text-sm">
            <p className="font-medium text-zinc-100">You&apos;re out of credits for this one</p>
            <p className="mt-1 text-zinc-300">
              {m.error}{" "}
              {paymentsOn
                ? "Pick a plan or top up to keep going, or wait for your free monthly credits."
                : "Your free credits refill on the 1st of each month."}
            </p>
            {onBuyCredits && (
              <button
                onClick={onBuyCredits}
                className="mt-3 rounded-lg bg-gold-brand px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:brightness-105"
              >
                {paymentsOn ? "Get more credits" : "See your credits"}
              </button>
            )}
          </div>
        ) : (
          m.error && (
            <div role="status" className="mt-2 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {m.error}
            </div>
          )
        )}
        <Actions m={m} onRetry={m.errorCode === "confirm_cost" ? undefined : onRetry} />
      </div>
    </div>
  );
}
