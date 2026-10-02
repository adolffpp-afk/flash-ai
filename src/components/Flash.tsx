"use client";

import { useEffect, useRef, useState } from "react";
import { Message } from "./Message";
import { AuthScreen } from "./AuthScreen";
import { CreditsDialog } from "./CreditsDialog";
import { ENGINES, ENGINE_LABELS, type Attachment, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types";
import { api, newId, type Me, type ProjectSummary, type UIMessage } from "@/lib/store";

// A project's messages are loaded the first time it is opened.
type Project = ProjectSummary & { messages?: UIMessage[] };

type Choice = Engine | "auto";
const CHOICES: Choice[] = ["auto", ...ENGINES];
const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.md,.csv,.txt,.json," +
  "audio/*,video/mp4,video/webm,video/quicktime";
const MAX_FILE_MB = 25;

const SUGGESTIONS: { icon: string; engine: Engine; text: string }[] = [
  { icon: "🛠️", engine: "app", text: "Build a habit tracker app with streaks and a weekly chart" },
  { icon: "🖥️", engine: "slides", text: "Make a presentation about the future of solar energy in Africa" },
  { icon: "✍️", engine: "text", text: "Write a friendly email asking my landlord to fix the heater" },
  { icon: "🔎", engine: "search", text: "What's the latest news in AI this week?" },
  { icon: "💻", engine: "code", text: "Write a Python function that checks if a number is prime" },
  { icon: "🌍", engine: "translate", text: "Translate 'Welcome to our shop' into French, Spanish and Yoruba" },
  { icon: "📊", engine: "docs", text: "Create a monthly budget spreadsheet for a family of four" },
  { icon: "🎨", engine: "image", text: "Draw a minimalist logo for a coffee shop called Flash Brew" },
  { icon: "🎬", engine: "video", text: "Make a video of ocean waves at sunset, slow drone shot" },
  { icon: "🎵", engine: "music", text: "Compose an upbeat jingle for a bakery ad" },
  { icon: "🔊", engine: "voice", text: "Read this aloud: Welcome to Flash, your all-in-one AI." },
  { icon: "📝", engine: "transcribe", text: "Attach a recording and get a clean transcript" },
];

type Status = Record<Engine, boolean>;

function applyEvent(m: UIMessage, e: StreamEvent): UIMessage {
  switch (e.type) {
    case "route":
      return { ...m, engine: e.engine, reason: e.reason, demo: e.demo, cost: e.cost, model: e.model, modelWhy: e.modelWhy };
    case "text":
      return m.app ? { ...m, after: (m.after ?? "") + e.delta } : { ...m, content: m.content + e.delta };
    case "status":
      return { ...m, status: e.message };
    case "image":
      return { ...m, status: undefined, images: [...(m.images ?? []), { url: e.url, prompt: e.prompt }] };
    case "video":
      return { ...m, status: undefined, videos: [...(m.videos ?? []), { url: e.url, prompt: e.prompt }] };
    case "audio":
      return { ...m, status: undefined, audio: e.url, audioLabel: e.label };
    case "app":
      return { ...m, status: undefined, app: e.app };
    case "sources":
      return { ...m, sources: e.items };
    case "error":
      return { ...m, error: e.message };
    case "done":
      return { ...m, pending: false, status: undefined };
  }
}

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
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const [notice, setNotice] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [preferences, setPreferences] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [input, setInput] = useState("");
  const [choice, setChoice] = useState<Choice>("auto");
  // Image, video and music model picked per engine; missing means Flash picks.
  const [models, setModels] = useState<Partial<Record<Engine, string>>>({});
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [dragging, setDragging] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Attachments stay in memory only (too large to save), keyed by user message id, for Retry.
  const filesRef = useRef(new Map<string, Attachment>());
  // Projects whose messages changed and still need saving to the server.
  const dirtyRef = useRef(new Set<string>());
  const prefsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function refreshMe() {
    try {
      const data = await api<Me>("/api/me");
      setMe(data);
      return data;
    } catch (err) {
      if ((err as { status?: number }).status === 401) setSignedOut(true);
      return null;
    }
  }

  async function start() {
    const data = await refreshMe();
    if (!data) return;
    setSignedOut(false);
    setPreferences(data.user.preferences);
    let { projects: list } = await api<{ projects: ProjectSummary[] }>("/api/projects");
    if (!list.length) list = [(await api<{ project: ProjectSummary }>("/api/projects", { method: "POST", json: { name: "My first project" } })).project];
    setProjects(list);
    await openProject(list[0].id);
  }

  useEffect(() => {
    // Loading the account must wait for the browser, so this runs once after mount.
    start();
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get("purchase");
    if (purchase) {
      setNotice(purchase === "success" ? "Thanks! Your credits were added." : "Checkout was cancelled. No charge was made.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saves changed projects shortly after a reply finishes.
  useEffect(() => {
    if (busy || !dirtyRef.current.size) return;
    const timer = setTimeout(() => {
      for (const id of dirtyRef.current) {
        const p = projects.find((x) => x.id === id);
        dirtyRef.current.delete(id);
        if (!p?.messages) continue;
        const messages = p.messages.map((m) => ({ ...m, pending: undefined, status: undefined }));
        api(`/api/projects/${id}`, { method: "PUT", json: { name: p.name, messages } }).catch((err) =>
          setNotice(err instanceof Error ? err.message : "Couldn't save your project."),
        );
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [projects, busy]);

  const active = projects.find((p) => p.id === activeId);

  useEffect(() => {
    if (active?.messages?.length) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.messages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [input]);

  async function openProject(id: string) {
    setActiveId(id);
    setSidebar(false);
    if (projects.find((p) => p.id === id)?.messages) return;
    try {
      const { project } = await api<{ project: Project }>(`/api/projects/${id}`);
      setProjects((list) => list.map((p) => (p.id === id ? { ...p, messages: p.messages ?? project.messages } : p)));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't open that project.");
    }
  }

  function updateProject(id: string, fn: (p: Project) => Project) {
    dirtyRef.current.add(id);
    setProjects((list) => list.map((p) => (p.id === id ? fn(p) : p)));
  }

  function updateMessage(projectId: string, messageId: string, fn: (m: UIMessage) => UIMessage) {
    updateProject(projectId, (p) => ({
      ...p,
      updated_at: Date.now(),
      messages: (p.messages ?? []).map((m) => (m.id === messageId ? fn(m) : m)),
    }));
  }

  async function createProject() {
    try {
      const { project } = await api<{ project: ProjectSummary }>("/api/projects", { method: "POST", json: {} });
      setProjects((list) => [{ ...project, messages: [] }, ...list]);
      setActiveId(project.id);
      setSidebar(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't create a project.");
    }
  }

  async function deleteProject(id: string) {
    if (!confirm("Delete this project and its history?")) return;
    dirtyRef.current.delete(id);
    await api(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
    const rest = projects.filter((p) => p.id !== id);
    if (!rest.length) {
      setProjects([]);
      await start();
      return;
    }
    setProjects(rest);
    if (id === activeId) openProject(rest[0].id);
  }

  function renameProject(id: string) {
    const current = projects.find((p) => p.id === id);
    const name = prompt("Project name", current?.name)?.trim();
    if (!name) return;
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
    api(`/api/projects/${id}`, { method: "PUT", json: { name } }).catch(() => {});
  }

  function changePreferences(value: string) {
    setPreferences(value);
    clearTimeout(prefsTimer.current);
    prefsTimer.current = setTimeout(() => api("/api/me", { method: "PATCH", json: { preferences: value } }).catch(() => {}), 600);
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
    setProjects([]);
    setActiveId("");
    filesRef.current.clear();
    setSignedOut(true);
  }

  function setAppSlug(messageId: string, slug: string) {
    if (active) updateMessage(active.id, messageId, (m) => (m.app ? { ...m, app: { ...m.app, slug } } : m));
  }

  async function send(text: string) {
    if (!active?.messages || busy) return;
    const content = text.trim();
    if (!content && !attachment) return;
    const userMsg: UIMessage = { id: newId(), role: "user", content, attachmentName: attachment?.name };
    if (attachment) filesRef.current.set(userMsg.id, attachment);
    updateProject(active.id, (p) => ({
      ...p,
      name: !p.messages?.length && p.name === "New project" ? content.slice(0, 40) || p.name : p.name,
    }));
    setInput("");
    setAttachment(null);
    await respond(active, active.messages ?? [], userMsg);
  }

  /** Answers the last user message again, replacing the reply after it. */
  async function retry() {
    const messages = active?.messages;
    if (!active || !messages || busy) return;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    if (lastUser === -1) return;
    await respond(active, messages.slice(0, lastUser), messages[lastUser]);
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function respond(project: Project, earlier: UIMessage[], userMsg: UIMessage) {
    const projectId = project.id;
    const reply: UIMessage = { id: newId(), role: "assistant", content: "", pending: true };
    const file = filesRef.current.get(userMsg.id);

    // Only the most recent app's code is sent back, so edits build on it without resending every version.
    const lastAppId = [...earlier].reverse().find((m) => m.app)?.id;
    const previous = [...earlier].reverse().find((m) => m.role === "assistant" && m.engine)?.engine;
    const history: ChatTurn[] = [
      ...earlier
        .filter((m) => !m.error || m.content || m.app)
        .map((m) => ({
          role: m.role,
          content: m.content + (m.after ?? ""),
          app: m.id === lastAppId ? m.app?.html : undefined,
        })),
      { role: "user", content: userMsg.content, attachment: file },
    ];

    updateProject(projectId, (p) => ({ ...p, updated_at: Date.now(), messages: [...earlier, userMsg, reply] }));
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          engine: choice,
          preferences,
          previous,
          model: choice === "auto" ? undefined : models[choice],
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
        if (res.status === 401) setSignedOut(true);
        throw Object.assign(new Error(err.error), { code: err.code as string | undefined });
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
          updateMessage(projectId, reply.id, (m) => applyEvent(m, e));
        }
      }
    } catch (err) {
      const aborted = controller.signal.aborted;
      updateMessage(projectId, reply.id, (m) =>
        aborted
          ? { ...m, stopped: true }
          : {
              ...m,
              error: err instanceof Error ? err.message : "Something went wrong.",
              errorCode: (err as { code?: string }).code,
            },
      );
    } finally {
      updateMessage(projectId, reply.id, (m) => ({ ...m, pending: false, status: undefined }));
      refreshMe();
      abortRef.current = null;
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert(`Files must be ${MAX_FILE_MB} MB or smaller.`);
      return;
    }
    setAttachment(await readFile(file));
    inputRef.current?.focus();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    attach(file);
  }

  const sorted = [...projects].sort((a, b) => b.updated_at - a.updated_at);
  const demoAll = status && !Object.values(status).some(Boolean);

  if (signedOut) return <AuthScreen onDone={start} />;
  if (!me) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-400" aria-label="Loading" />
      </div>
    );
  }

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
              <button className="min-w-0 flex-1 truncate px-3 py-2 text-left" onClick={() => openProject(p.id)}>
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
            onChange={(e) => changePreferences(e.target.value)}
            placeholder="e.g. I run a small bakery in Lagos. Keep answers short."
            rows={3}
            className="mt-1 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-sm outline-none focus:border-indigo-500"
          />
          {status && (
            <details className="mt-2 text-xs text-zinc-400">
              <summary className="cursor-pointer select-none hover:text-zinc-200">
                {ENGINES.filter((e) => status[e]).length} of {ENGINES.length} engines live
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-1">
                {ENGINES.map((e) => (
                  <span key={e} className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${status[e] ? "bg-emerald-400" : "bg-amber-400"}`} />
                    {ENGINE_LABELS[e]} {status[e] ? "live" : "demo"}
                  </span>
                ))}
              </div>
            </details>
          )}
          <div className="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-3 text-sm">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs uppercase">
              {(me.user.name || me.user.email)[0]}
            </span>
            <span className="min-w-0 flex-1 truncate text-zinc-300" title={me.user.email}>
              {me.user.name || me.user.email}
            </span>
            <button onClick={signOut} className="text-xs text-zinc-500 hover:text-zinc-200">
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          attach(e.dataTransfer.files[0]);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-indigo-400 bg-indigo-500/10 text-lg font-medium text-indigo-200">
            Drop a file for Flash to read, analyse or transcribe
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/80 px-4 py-3 backdrop-blur">
          <button className="text-zinc-400 md:hidden" onClick={() => setSidebar(true)} aria-label="Open menu">
            ☰
          </button>
          <h1 className="min-w-0 flex-1 truncate font-medium">{active?.name ?? "Flash AI"}</h1>
          <button
            onClick={() => setShowCredits(true)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition hover:bg-zinc-900 ${
              me.credits < 10 ? "border-amber-500/50 text-amber-300" : "border-zinc-700 text-zinc-200"
            }`}
            title="Credits: see costs and top up"
          >
            ⚡ {me.credits.toLocaleString()} credits
          </button>
        </header>
        {showCredits && <CreditsDialog me={me} onClose={() => setShowCredits(false)} onChanged={refreshMe} />}

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
            {notice && (
              <div className="flex items-start gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100">
                <span className="flex-1">{notice}</span>
                <button onClick={() => setNotice("")} aria-label="Dismiss" className="text-indigo-300 hover:text-white">
                  ✕
                </button>
              </div>
            )}
            {demoAll && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                Flash is running in demo mode, so nothing uses credits yet. Add your API keys to <code>.env.local</code> to
                switch on real answers.
              </div>
            )}
            {active?.messages && active.messages.length === 0 && (
              <div className="pt-6 text-center sm:pt-12">
                <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-pink-500 text-3xl shadow-lg shadow-fuchsia-500/20">
                  ⚡
                </div>
                <h2 className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
                  One AI for everything
                </h2>
                <p className="mx-auto mt-3 max-w-lg text-zinc-400">
                  Build apps, make slides, write, research, code, translate, crunch spreadsheets, and create images,
                  video, music and voice. Ask anything and Flash picks the best AI for the job.
                </p>
                <div className="mt-8 grid grid-cols-1 gap-2 text-left sm:grid-cols-2 lg:grid-cols-3">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s.text}
                      onClick={() => (s.engine === "transcribe" ? fileRef.current?.click() : send(s.text))}
                      className="group rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-left transition hover:-translate-y-0.5 hover:border-indigo-500/60 hover:bg-zinc-900"
                    >
                      <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 group-hover:text-indigo-300">
                        <span className="text-base" aria-hidden>
                          {s.icon}
                        </span>
                        {ENGINE_LABELS[s.engine]}
                      </div>
                      <div className="mt-1.5 text-sm leading-snug text-zinc-200">{s.text}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {active?.messages?.map((m, i, all) => (
              <Message
                key={m.id}
                m={m}
                onRetry={i === all.length - 1 && m.role === "assistant" && !m.pending && !busy ? retry : undefined}
                onBuyCredits={() => setShowCredits(true)}
                onPublished={(slug) => setAppSlug(m.id, slug)}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="px-4 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <div
              className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
              role="radiogroup"
              aria-label="Engine"
            >
              {CHOICES.map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={choice === c}
                  title={c === "auto" ? "Flash picks the best engine for each message" : `Always use ${ENGINE_LABELS[c]}`}
                  onClick={() => setChoice(c)}
                  className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs transition ${
                    choice === c
                      ? "bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white shadow"
                      : "border border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                  }`}
                >
                  {c === "auto" ? "⚡ Auto" : ENGINE_LABELS[c]}
                </button>
              ))}
            </div>
            {choice !== "auto" && me.models.some((x) => x.engine === choice) && (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <label htmlFor="model">Model</label>
                <select
                  id="model"
                  value={models[choice] ?? ""}
                  onChange={(e) => setModels((all) => ({ ...all, [choice]: e.target.value || undefined }))}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-200 outline-none focus:border-indigo-500"
                >
                  <option value="">⚡ Best for each request</option>
                  {me.models
                    .filter((x) => x.engine === choice)
                    .map((x) => (
                      <option key={x.id} value={x.id} disabled={!x.live}>
                        {x.label} · {x.credits} credits{x.live ? "" : " (not set up)"}
                      </option>
                    ))}
                </select>
                <span className="hidden truncate sm:inline">
                  {me.models.find((x) => x.id === models[choice])?.blurb ??
                    "Flash matches each request to the model that suits it."}
                </span>
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="rounded-2xl border border-zinc-800 bg-zinc-900 p-2 shadow-xl shadow-black/30 transition focus-within:border-indigo-500/70"
            >
              {attachment && (
                <div className="mb-1 ml-1 inline-flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-200">
                  📎 {attachment.name}
                  <button
                    type="button"
                    onClick={() => setAttachment(null)}
                    aria-label="Remove file"
                    className="text-zinc-400 hover:text-zinc-100"
                  >
                    ✕
                  </button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="Attach a file"
                  title="Attach a PDF, image, spreadsheet, text, audio or video file"
                >
                  📎
                </button>
                <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={onFile} />
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => {
                    const file = [...e.clipboardData.files][0];
                    if (file) {
                      e.preventDefault();
                      attach(file);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  rows={1}
                  placeholder={choice === "auto" ? "Ask Flash anything…" : `Ask ${ENGINE_LABELS[choice]}…`}
                  className="max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 outline-none placeholder:text-zinc-500"
                  aria-label="Message"
                />
                {busy ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="rounded-xl border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
                  >
                    ■ Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() && !attachment}
                    className="rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40"
                  >
                    Send
                  </button>
                )}
              </div>
            </form>
            <p className="mt-2 hidden text-center text-xs text-zinc-600 sm:block">
              Enter to send · Shift + Enter for a new line · drop or paste files anywhere
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
