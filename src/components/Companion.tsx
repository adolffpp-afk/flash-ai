"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { LogoMark } from "@/app/brand";
import { ENGINE_LABELS } from "@/lib/types";
import { newId } from "@/lib/store";
import type { CompanionAction, CompanionContext, CompanionEvent, CompanionTurn } from "@/lib/companion";

type Line = CompanionTurn & { id: string; pending?: boolean; error?: boolean };

const STARTERS = [
  "What can Flash do?",
  "How long will this take?",
  "How are my websites doing?",
  "What have I spent credits on?",
];

// Links open in a new tab, so the job running in the chat isn't lost. Pictures aren't shown at all:
// a picture loads by itself, which would let a crafted answer send what it knows to another site.
const markdown: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  img: () => null,
};

/** The questions offered while a job is running, which are the ones people actually ask then. */
const BUSY_STARTERS = ["How long will this take?", "What will this cost me?", "What should I ask for next?"];

/**
 * The Flash companion: a side panel the user can talk to at any time, including while Flash is
 * still working in their chat. It answers about Flash and their own work, opens pages, and lines
 * up requests to run in the chat next.
 */
export function Companion({
  open,
  onOpen,
  onClose,
  context,
  onQueue,
  onPage,
  onCost,
  running,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  // Read when a question is sent, so the companion sees what is happening right then.
  context: () => CompanionContext;
  // "waiting" requests need the user to press Run in Next up.
  onQueue: (request: string, waiting?: boolean) => void;
  onPage: (page: string) => void;
  // A finished answer may have changed the user's credits.
  onCost: () => void;
  // What Flash is doing in the chat right now, for the line at the top of the panel.
  running: { engine?: string; status?: string } | null;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const linesNow = useRef<Line[]>([]);
  const update = useCallback((next: Line[]) => {
    linesNow.current = next;
    setLines(next);
  }, []);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  useEffect(() => {
    if (lines.length) bottom.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Closing the panel stops the answer, so nothing keeps spending and nothing it asked for still happens.
  useEffect(() => {
    if (!open) abort.current?.abort();
  }, [open]);
  useEffect(() => () => abort.current?.abort(), []);

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const reply: Line = { id: newId(), role: "assistant", content: "", pending: true };
    const sent: Line[] = [...linesNow.current, { id: newId(), role: "user", content: question }, reply];
    update(sent);
    setInput("");
    setBusy(true);
    setStatus("");
    const controller = new AbortController();
    abort.current = controller;
    const patch = (change: (line: Line) => Line) =>
      update(linesNow.current.map((l) => (l.id === reply.id ? change(l) : l)));
    try {
      const res = await fetch("/api/companion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: sent.filter((l) => !l.pending && !l.error).map((l) => ({ role: l.role, content: l.content })),
          context: context(),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Something went wrong (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const rows = buffer.split("\n");
        buffer = rows.pop() ?? "";
        for (const row of rows) {
          if (controller.signal.aborted) break;
          if (!row.trim()) continue;
          const event = JSON.parse(row) as CompanionEvent;
          if (event.type === "text") patch((l) => ({ ...l, content: l.content + event.delta }));
          else if (event.type === "status") setStatus(event.message);
          else if (event.type === "action") act(event.action);
          else if (event.type === "cost") onCost();
          else if (event.type === "error") patch((l) => ({ ...l, content: l.content || event.message, error: true }));
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        patch((l) => ({ ...l, content: err instanceof Error ? err.message : "Something went wrong.", error: true }));
      }
    } finally {
      patch((l) => ({ ...l, pending: false }));
      setStatus("");
      setBusy(false);
      abort.current = null;
      // Back to the question box, unless the user is typing somewhere else by now.
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) field.current?.focus();
    }
  }

  function act(action: CompanionAction) {
    if (action.kind === "queue") onQueue(action.request, action.waiting);
    else onPage(action.page);
  }

  if (!open) {
    return (
      <button
        onClick={onOpen}
        aria-label="Ask Flash"
        title="Ask the companion anything, even while Flash is working"
        className="fixed bottom-24 right-4 z-30 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-zinc-900/90 px-3.5 py-2 text-sm text-zinc-100 shadow-lg shadow-black/40 backdrop-blur transition hover:border-primary hover:bg-zinc-900 sm:bottom-6"
      >
        <LogoMark size={18} />
        <span className="hidden sm:inline">Ask Flash</span>
        {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />}
      </button>
    );
  }

  const starters = running ? BUSY_STARTERS : STARTERS;
  return (
    // On a phone it slides up over the chat; on a wider screen it sits beside it, so the chat stays usable.
    <aside
      className="fixed inset-x-0 bottom-0 z-30 flex h-[70dvh] flex-col border-t border-white/10 bg-zinc-950/95 backdrop-blur sm:static sm:z-0 sm:h-full sm:w-[22rem] sm:shrink-0 sm:border-l sm:border-t-0 sm:bg-zinc-950/60 sm:backdrop-blur-none"
      aria-label="Flash companion"
    >
      <div className="flex items-center gap-2 border-b border-white/6 px-4 py-3">
        <LogoMark size={20} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-100">Companion</p>
          <p className="truncate text-xs text-zinc-500">
            {running
              ? `Flash is working on your ${running.engine ? (ENGINE_LABELS[running.engine as keyof typeof ENGINE_LABELS] ?? "request").toLowerCase() : "request"} — ask me anything meanwhile`
              : "Ask about Flash, your work, or what to make next"}
          </p>
        </div>
        <button onClick={onClose} aria-label="Close companion" className="rounded-full p-1.5 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {lines.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-zinc-400">
              I know how Flash works and what you&apos;ve made here. I can also line up your next request while something is running.
            </p>
            {starters.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                className="block w-full rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2 text-left text-sm text-zinc-200 transition hover:border-white/15 hover:bg-white/[0.05]"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {lines.map((l) =>
          l.role === "user" ? (
            <p key={l.id} className="ml-6 rounded-2xl rounded-br-md bg-primary/15 px-3 py-2 text-sm text-zinc-100">
              {l.content}
            </p>
          ) : (
            <div key={l.id} className={`mr-2 text-sm leading-relaxed ${l.error ? "text-red-400" : "text-zinc-200"}`}>
              {l.content ? (
                <div className="prose prose-sm prose-invert max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
                    {l.content}
                  </ReactMarkdown>
                </div>
              ) : !l.pending ? (
                <span className="text-zinc-500">Stopped.</span>
              ) : (
                <span className="inline-flex items-center gap-2 text-zinc-400">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-gold" aria-hidden />
                  {status || "Thinking…"}
                </span>
              )}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="border-t border-white/6 p-3"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-zinc-900/70 p-2 focus-within:border-white/20">
          <textarea
            ref={field}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={1}
            placeholder="Ask the companion…"
            aria-label="Ask the companion"
            className="max-h-24 min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-zinc-500"
          />
          {busy ? (
            // Its own element (the key), so stopping can't turn it into the send button mid-click.
            <button
              key="stop"
              type="button"
              onClick={(e) => {
                e.preventDefault();
                abort.current?.abort();
              }}
              aria-label="Stop"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900"
            >
              <span className="h-3 w-3 rounded-[2px] bg-current" />
            </button>
          ) : (
            <button
              key="send"
              type="submit"
              disabled={!input.trim()}
              aria-label="Send to companion"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5 M6 11l6-6 6 6" />
              </svg>
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-zinc-600">A few credits per answer. Free models answer when your credits run out.</p>
      </form>
    </aside>
  );
}
