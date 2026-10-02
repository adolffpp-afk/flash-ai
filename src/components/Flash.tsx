"use client";

import { useEffect, useRef, useState } from "react";
import { Message } from "./Message";
import { ENGINE_LABELS, type Attachment, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types";
import {
  loadPreferences,
  loadProjects,
  newId,
  newProject,
  savePreferences,
  saveProjects,
  type Project,
  type UIMessage,
} from "@/lib/store";

type Choice = Engine | "auto";
const CHOICES: Choice[] = ["auto", "text", "search", "image", "voice"];
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.md,.csv,.txt";

const SUGGESTIONS = [
  "Write a friendly email asking my landlord to fix the heater",
  "What's the latest news in AI this week?",
  "Draw a minimalist logo for a coffee shop called Flash Brew",
  "Read this aloud: Welcome to Flash, your all-in-one AI.",
];

type Status = Record<Engine, boolean>;

function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name, mediaType: file.type || "text/plain", data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Flash() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [preferences, setPreferences] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [input, setInput] = useState("");
  const [choice, setChoice] = useState<Choice>("auto");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = loadProjects();
    const list = saved.length ? saved : [newProject("My first project")];
    // Reading localStorage must wait for the browser, so this sync runs once after mount.
    setProjects(list);
    setActiveId(list[0].id);
    setPreferences(loadPreferences());
    setLoaded(true);
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (loaded) saveProjects(projects);
  }, [projects, loaded]);

  const active = projects.find((p) => p.id === activeId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.messages]);

  function updateProject(id: string, fn: (p: Project) => Project) {
    setProjects((list) => list.map((p) => (p.id === id ? fn(p) : p)));
  }

  function updateMessage(projectId: string, messageId: string, fn: (m: UIMessage) => UIMessage) {
    updateProject(projectId, (p) => ({
      ...p,
      updatedAt: Date.now(),
      messages: p.messages.map((m) => (m.id === messageId ? fn(m) : m)),
    }));
  }

  function createProject() {
    const p = newProject();
    setProjects((list) => [p, ...list]);
    setActiveId(p.id);
    setSidebar(false);
  }

  function deleteProject(id: string) {
    if (!confirm("Delete this project and its history?")) return;
    setProjects((list) => {
      const rest = list.filter((p) => p.id !== id);
      const next = rest.length ? rest : [newProject("My first project")];
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  }

  function renameProject(id: string) {
    const current = projects.find((p) => p.id === id);
    const name = prompt("Project name", current?.name)?.trim();
    if (name) updateProject(id, (p) => ({ ...p, name }));
  }

  async function send(text: string) {
    if (!active || busy) return;
    const content = text.trim();
    if (!content && !attachment) return;
    const projectId = active.id;
    const userMsg: UIMessage = { id: newId(), role: "user", content, attachmentName: attachment?.name };
    const reply: UIMessage = { id: newId(), role: "assistant", content: "", pending: true };

    const history: ChatTurn[] = [
      ...active.messages.filter((m) => !m.error || m.content).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content, attachment: attachment ?? undefined },
    ];

    updateProject(projectId, (p) => ({
      ...p,
      name: p.messages.length === 0 && p.name === "New project" ? content.slice(0, 40) || p.name : p.name,
      updatedAt: Date.now(),
      messages: [...p.messages, userMsg, reply],
    }));
    setInput("");
    setAttachment(null);
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, engine: choice, preferences }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
        throw new Error(err.error);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as StreamEvent;
          updateMessage(projectId, reply.id, (m) => {
            switch (e.type) {
              case "route":
                return { ...m, engine: e.engine, reason: e.reason, demo: e.demo };
              case "text":
                return { ...m, content: m.content + e.delta };
              case "image":
                return { ...m, images: [...(m.images ?? []), { url: e.url, prompt: e.prompt }] };
              case "audio":
                return { ...m, audio: e.url };
              case "sources":
                return { ...m, sources: e.items };
              case "error":
                return { ...m, error: e.message };
              case "done":
                return { ...m, pending: false };
            }
          });
        }
      }
    } catch (err) {
      updateMessage(projectId, reply.id, (m) => ({
        ...m,
        error: err instanceof Error ? err.message : "Something went wrong.",
      }));
    } finally {
      updateMessage(projectId, reply.id, (m) => ({ ...m, pending: false }));
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alert("Files must be 10 MB or smaller.");
      return;
    }
    setAttachment(await readFile(file));
  }

  const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
  const demoAll = status && !Object.values(status).some(Boolean);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className={`${sidebar ? "flex" : "hidden"} fixed inset-0 z-20 w-full flex-col border-r border-zinc-800 bg-zinc-950 md:static md:flex md:w-72`}
      >
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-pink-500">⚡</span>
            Flash AI
          </div>
          <button className="text-zinc-400 md:hidden" onClick={() => setSidebar(false)} aria-label="Close menu">
            ✕
          </button>
        </div>
        <div className="px-3">
          <button
            onClick={createProject}
            className="w-full rounded-lg border border-zinc-800 px-3 py-2 text-left text-sm hover:bg-zinc-900"
          >
            + New project
          </button>
        </div>
        <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3">
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center rounded-lg text-sm ${p.id === activeId ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
            >
              <button
                className="min-w-0 flex-1 truncate px-3 py-2 text-left"
                onClick={() => {
                  setActiveId(p.id);
                  setSidebar(false);
                }}
              >
                {p.name}
              </button>
              <button
                className="px-1 text-zinc-500 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
                onClick={() => renameProject(p.id)}
                aria-label="Rename project"
              >
                ✎
              </button>
              <button
                className="px-2 text-zinc-500 opacity-0 hover:text-red-400 group-hover:opacity-100"
                onClick={() => deleteProject(p.id)}
                aria-label="Delete project"
              >
                🗑
              </button>
            </div>
          ))}
        </nav>
        <div className="border-t border-zinc-800 p-3">
          <label className="text-xs font-medium text-zinc-400" htmlFor="prefs">
            Memory: what Flash should know about you
          </label>
          <textarea
            id="prefs"
            value={preferences}
            onChange={(e) => {
              setPreferences(e.target.value);
              savePreferences(e.target.value);
            }}
            placeholder="e.g. I run a small bakery in Lagos. Keep answers short."
            rows={3}
            className="mt-1 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-sm outline-none focus:border-indigo-500"
          />
          {status && (
            <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-zinc-400">
              {(Object.keys(ENGINE_LABELS) as Engine[]).map((e) => (
                <span key={e} className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${status[e] ? "bg-emerald-400" : "bg-amber-400"}`} />
                  {ENGINE_LABELS[e]} {status[e] ? "live" : "demo"}
                </span>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <button className="text-zinc-400 md:hidden" onClick={() => setSidebar(true)} aria-label="Open menu">
            ☰
          </button>
          <h1 className="truncate font-medium">{active?.name ?? "Flash AI"}</h1>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
            {demoAll && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                Flash is running in demo mode. Add your API keys to <code>.env.local</code> to switch on real answers.
              </div>
            )}
            {active && active.messages.length === 0 && (
              <div className="pt-10 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-pink-500 text-2xl">
                  ⚡
                </div>
                <h2 className="text-2xl font-semibold">What can Flash do for you?</h2>
                <p className="mt-2 text-zinc-400">Ask anything. Flash picks the best AI for the job.</p>
                <div className="mt-8 grid gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-xl border border-zinc-800 p-3 text-left text-sm text-zinc-300 hover:border-indigo-500 hover:bg-zinc-900"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {active?.messages.map((m) => <Message key={m.id} m={m} />)}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-zinc-800 px-4 pb-4 pt-3">
          <div className="mx-auto max-w-3xl">
            <div className="mb-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Engine">
              {CHOICES.map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={choice === c}
                  onClick={() => setChoice(c)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    choice === c ? "bg-indigo-600 text-white" : "border border-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {c === "auto" ? "⚡ Auto" : ENGINE_LABELS[c]}
                </button>
              ))}
            </div>
            {attachment && (
              <div className="mb-2 inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
                📎 {attachment.name}
                <button onClick={() => setAttachment(null)} aria-label="Remove file" className="text-zinc-500 hover:text-zinc-200">
                  ✕
                </button>
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-2 focus-within:border-indigo-500"
            >
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                aria-label="Attach a file"
              >
                📎
              </button>
              <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={onFile} />
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                placeholder="Ask Flash anything…"
                className="max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 outline-none"
                aria-label="Message"
              />
              <button
                type="submit"
                disabled={busy || (!input.trim() && !attachment)}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                {busy ? "…" : "Send"}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
