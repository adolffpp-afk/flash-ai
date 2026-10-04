"use client";

import { useEffect, useRef, useState } from "react";
import { Message } from "./Message";
import { AuthScreen } from "./AuthScreen";
import { Landing } from "./Landing";
import { VerifyBanner } from "./VerifyBanner";
import { CreditsDialog } from "./CreditsDialog";
import { InviteDialog } from "./InviteFriends";
import { InstallApp, InstallPopup } from "./InstallApp";
import { ENGINES, ENGINE_LABELS, type Attachment, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types";
import { api, newId, type Me, type Pricing, type ProjectSummary, type UIMessage } from "@/lib/store";
import { BoltIcon, Logo, LogoMark } from "@/app/brand";
import { EngineIcon } from "./EngineIcon";
import { MicButton, PlusMenu, SendButton, ToolPicker, type Choice } from "./ComposerTools";

// A project's messages are loaded the first time it is opened.
type Project = ProjectSummary & { messages?: UIMessage[] };

const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.md,.csv,.txt,.json," +
  "audio/*,video/mp4,video/webm,video/quicktime";
const MAX_FILE_MB = 3;

/** "Adolff" from "Adolff Pierre", or from adolff.p@example.com when no name was given. */
function firstName(user: { name: string; email: string }): string {
  const name = user.name.trim().split(/\s+/)[0] || user.email.split("@")[0].split(/[._+-]/)[0];
  return name ? name[0].toUpperCase() + name.slice(1) : "there";
}

/** Good morning, afternoon or evening, by the visitor's own clock. */
function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
// A team invitation opened before signing in waits here until the account loads.
const INVITE_KEY = "flash_invite";
const storage = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Storage blocked: the invitation link can be opened again after signing in.
    }
  },
};
// What the image, video, music and voice engines make, for the welcome text.
const MEDIA_WORDS: [Engine, string][] = [
  ["image", "images"],
  ["video", "video"],
  ["music", "music"],
  ["voice", "voice"],
];

const SUGGESTIONS: { engine: Engine; text: string }[] = [
  { engine: "app", text: "Build a habit tracker app with streaks and a weekly chart" },
  { engine: "slides", text: "Make a presentation about the future of solar energy in Africa" },
  { engine: "text", text: "Write a friendly email asking my landlord to fix the heater" },
  { engine: "search", text: "What's the latest news in AI this week?" },
  { engine: "code", text: "Write a Python function that checks if a number is prime" },
  { engine: "translate", text: "Translate 'Welcome to our shop' into French, Spanish and Yoruba" },
  { engine: "docs", text: "Create a monthly budget spreadsheet for a family of four" },
  { engine: "image", text: "Draw a minimalist logo for a coffee shop called Flash Brew" },
  { engine: "video", text: "Make a video of ocean waves at sunset, slow drone shot" },
  { engine: "music", text: "Compose an upbeat jingle for a bakery ad" },
  { engine: "voice", text: "Read this aloud: Welcome to Flash, your all-in-one AI." },
  { engine: "transcribe", text: "Attach a recording and get a clean transcript" },
];

export type Status = Record<Engine, boolean>;

function applyEvent(m: UIMessage, e: StreamEvent): UIMessage {
  switch (e.type) {
    case "route":
      return { ...m, engine: e.engine, reason: e.reason, demo: e.demo, cost: e.cost, model: e.model, modelWhy: e.modelWhy, free: e.free };
    case "text":
      return m.app ? { ...m, after: (m.after ?? "") + e.delta } : { ...m, content: m.content + e.delta };
    case "status":
      return { ...m, status: e.message };
    case "cost":
      return { ...m, cost: e.credits };
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

export function Flash({
  signedIn = true,
  initialStatus,
  pricing,
}: {
  // False when the browser has no session cookie, so the landing page shows straight away.
  signedIn?: boolean;
  initialStatus?: Status;
  // Prices for the landing page, when the server already has them.
  pricing?: Pricing;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(!signedIn);
  const [loadError, setLoadError] = useState(false);
  // Signed-out visitors see the landing page until they choose to sign up or sign in.
  const [authMode, setAuthMode] = useState<"signup" | "login" | null>(null);
  const [authError, setAuthError] = useState("");
  const [showCredits, setShowCredits] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [notice, setNotice] = useState("");
  // Set when sign-up couldn't send the confirmation email, so the banner asks to send it again.
  const [emailFailed, setEmailFailed] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [preferences, setPreferences] = useState("");
  const [status, setStatus] = useState<Status | null>(initialStatus ?? null);
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
  const cameraRef = useRef<HTMLInputElement>(null);
  const [projectQuery, setProjectQuery] = useState("");
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
      setLoadError(false);
      return data;
    } catch (err) {
      if ((err as { status?: number }).status === 401) setSignedOut(true);
      else setLoadError(true);
      return null;
    }
  }

  /** Joins the team from a saved invitation link, once signed in. */
  async function acceptInvite() {
    const token = storage.get(INVITE_KEY);
    if (!token) return;
    try {
      await api("/api/team/accept", { method: "POST", json: { token } });
      storage.set(INVITE_KEY, null);
      setNotice("You joined the team. Your requests now use the team's shared credits.");
      await refreshMe();
    } catch (err) {
      // An unconfirmed email can try again after confirming; any other answer is final.
      if ((err as { code?: string }).code !== "unverified") storage.set(INVITE_KEY, null);
      setNotice(err instanceof Error ? err.message : "Couldn't join the team.");
    }
  }

  async function start() {
    const data = await refreshMe();
    if (!data) return;
    setSignedOut(false);
    acceptInvite();
    setPreferences(data.user.preferences);
    try {
      let { projects: list } = await api<{ projects: ProjectSummary[] }>("/api/projects");
      if (!list.length) list = [(await api<{ project: ProjectSummary }>("/api/projects", { method: "POST", json: { name: "My first project" } })).project];
      setProjects(list);
      await openProject(list[0].id);
    } catch {
      setMe(null);
      setLoadError(true);
    }
  }

  useEffect(() => {
    // Loading the account must wait for the browser, so this runs once after mount.
    if (signedIn) start();
    if (!initialStatus) {
      fetch("/api/status")
        .then((r) => r.json())
        .then(setStatus)
        .catch(() => {});
    }
    const params = new URLSearchParams(window.location.search);
    // A referral link: the code waits in a cookie until sign-up (30 days).
    const ref = params.get("ref");
    if (ref && /^[A-Za-z0-9_-]{4,32}$/.test(ref)) {
      document.cookie = `flash_ref=${ref}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`;
    }
    const invite = params.get("invite");
    if (invite) {
      storage.set(INVITE_KEY, invite);
      if (!signedIn) setNotice("Sign in or create an account with the invited email to join the team.");
    }
    if (ref || invite) window.history.replaceState(null, "", window.location.pathname);
    const purchase = params.get("purchase");
    if (purchase) {
      setNotice(
        purchase === "success"
          ? "Thanks! Your credits were added."
          : purchase === "subscribed"
            ? "Welcome to your new plan! This month's credits are on their way."
            : "Checkout was cancelled. No charge was made.",
      );
      window.history.replaceState(null, "", window.location.pathname);
    }
    // A "Continue with …" sign-in that didn't finish comes back here to say why.
    const authErr = params.get("auth_error");
    if (authErr) {
      setAuthError(authErr);
      setAuthMode("login");
      window.history.replaceState(null, "", window.location.pathname);
    }
    const verified = params.get("verified");
    const reset = params.get("reset");
    if (verified || reset) {
      setNotice(
        reset
          ? "Your password was changed. You're signed in."
          : verified === "1"
            ? "Email confirmed. Your free credits were added."
            : "That confirmation link has expired or was already used. Send a new one from the banner.",
      );
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
    } catch {
      setNotice("Couldn't open that project. Pick it again in the sidebar to try again.");
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
    try {
      await api(`/api/projects/${id}`, { method: "DELETE" });
    } catch {
      setNotice("Couldn't delete that project. Please try again.");
      return;
    }
    dirtyRef.current.delete(id);
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
    if (!name || !current) return;
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
    api(`/api/projects/${id}`, { method: "PUT", json: { name } }).catch(() => {
      setProjects((list) => list.map((p) => (p.id === id ? { ...p, name: current.name } : p)));
      setNotice("Couldn't rename that project. Please try again.");
    });
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
    setAuthMode(null);
    setSignedOut(true);
  }

  function setAppSlug(messageId: string, slug: string) {
    if (active) updateMessage(active.id, messageId, (m) => (m.app ? { ...m, app: { ...m.app, slug } } : m));
  }

  async function send(text: string) {
    if (busy) return;
    if (!active?.messages) {
      if (active) setNotice("This project didn't load. Pick it again in the sidebar.");
      return;
    }
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

  /** Replaces the latest message with an edited one and asks again; the old reply is dropped. */
  async function editLast(text: string) {
    const messages = active?.messages;
    if (!active || !messages || busy) return;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    if (lastUser === -1) return;
    await respond(active, messages.slice(0, lastUser), { ...messages[lastUser], content: text });
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
    // Audio and video files go to Transcribe, so say so up front when it isn't available yet.
    if (/^(audio|video)\//.test(file.type) && status && !status.transcribe) {
      setNotice("Transcribing audio and video isn't available yet. It's coming soon.");
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

  const sorted = [...projects]
    .filter((p) => !projectQuery.trim() || p.name.toLowerCase().includes(projectQuery.trim().toLowerCase()))
    .sort((a, b) => b.updated_at - a.updated_at);
  // Engines whose AI provider isn't set up yet show as coming soon, and light up once /api/status says so.
  const isLive = (e: Engine) => !status || status[e];
  const liveCount = ENGINES.filter(isLive).length;
  const allOff = status && !liveCount;
  const makes = MEDIA_WORDS.filter(([e]) => isLive(e)).map(([, word]) => word);

  if (signedOut) {
    return authMode ? (
      <AuthScreen
        key={authMode}
        initialMode={authMode}
        initialError={authError}
        onDone={(result) => {
          setEmailFailed(Boolean(result?.emailFailed));
          start();
        }}
        onBack={() => {
          setAuthMode(null);
          setAuthError("");
        }}
      />
    ) : (
      <Landing onStart={setAuthMode} status={status} initialPricing={pricing} />
    );
  }
  if (!me && loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-zinc-400">
        <p>Flash couldn&apos;t load your account. Please try again in a moment.</p>
        <button
          onClick={() => {
            setLoadError(false);
            start();
          }}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-100 hover:bg-zinc-900"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-gold" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className={`${sidebar ? "flex" : "hidden"} fixed inset-0 z-20 w-full flex-col border-r border-white/6 bg-zinc-950 md:static md:flex md:w-64`}
      >
        <div className="flex items-center justify-between p-4">
          <Logo size={28} className="text-[15px]" />
          <button className="text-zinc-400 md:hidden" onClick={() => setSidebar(false)} aria-label="Close menu">
            ✕
          </button>
        </div>
        <div className="px-3">
          <button
            onClick={createProject}
            className="h-9 w-full rounded-lg border border-white/8 px-3 text-left text-sm text-zinc-200 transition hover:bg-white/[0.04]"
          >
            + New project
          </button>
        </div>
        {projects.length > 3 && (
          <div className="mt-3 px-3">
            <input
              type="search"
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="h-9 w-full rounded-lg border border-white/8 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-primary/70"
            />
          </div>
        )}
        <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3">
          {projectQuery.trim() && !sorted.length && <p className="px-2 py-1.5 text-xs text-zinc-500">No projects match.</p>}
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center rounded-lg text-sm ${p.id === activeId ? "bg-white/[0.06] text-white" : "text-zinc-300 hover:bg-white/[0.03]"}`}
            >
              <button className="min-w-0 flex-1 truncate px-3 py-1.5 text-left" onClick={() => openProject(p.id)}>
                {p.name}
              </button>
              <button
                className="px-1 text-zinc-500 hover:text-zinc-200 focus:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                onClick={() => renameProject(p.id)}
                aria-label="Rename project"
              >
                ✎
              </button>
              <button
                className="px-2 text-zinc-500 hover:text-red-400 focus:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                onClick={() => deleteProject(p.id)}
                aria-label="Delete project"
              >
                🗑
              </button>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/6 p-3">
          <label className="text-xs font-medium text-zinc-400" htmlFor="prefs">
            Memory: what Flash should know about you
          </label>
          <textarea
            id="prefs"
            value={preferences}
            onChange={(e) => changePreferences(e.target.value)}
            placeholder="e.g. I run a small bakery in Toronto. Keep answers short."
            rows={3}
            className="mt-1 w-full resize-none rounded-lg border border-white/8 bg-white/[0.03] p-2 text-sm outline-none placeholder:text-zinc-500 focus:border-primary/70"
          />
          <button
            onClick={() => setShowInvite(true)}
            className="mt-2 w-full rounded-lg border border-white/8 px-2 py-1.5 text-left text-xs text-gold-soft transition hover:bg-white/[0.04] hover:text-gold"
          >
            🎁 Invite friends, earn credits
          </button>
          <InstallApp className="mt-2 flex w-full items-center gap-2 rounded-lg border border-white/8 px-2 py-1.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.04] hover:text-white" />
          {status && (
            <details className="mt-2 text-xs text-zinc-400">
              <summary className="cursor-pointer select-none hover:text-zinc-200">
                {liveCount === ENGINES.length
                  ? `All ${liveCount} tools ready`
                  : `${liveCount} tools ready · ${ENGINES.length - liveCount} coming soon`}
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-1">
                {ENGINES.map((e) => (
                  <span key={e} className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${status[e] ? "bg-emerald-400" : "bg-zinc-600"}`} />
                    {ENGINE_LABELS[e]}
                    {!status[e] && <span className="text-zinc-500">coming soon</span>}
                  </span>
                ))}
              </div>
            </details>
          )}
          <div className="mt-3 flex items-center gap-2 border-t border-white/6 pt-3 text-sm">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs uppercase">
              {(me.user.name || me.user.email)[0]}
            </span>
            <span className="min-w-0 flex-1 truncate text-zinc-300" title={me.user.email}>
              {me.user.name || me.user.email}
            </span>
            {me.isAdmin && (
              <a href="/admin" className="text-xs text-primary-soft hover:text-white">
                Dashboard
              </a>
            )}
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
          <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10 text-lg font-medium text-primary-soft">
            Drop a file for Flash to read, analyse or transcribe
          </div>
        )}
        <header className="flex h-14 items-center gap-3 border-b border-white/6 bg-zinc-950/70 px-4 backdrop-blur-md">
          <button className="text-zinc-400 md:hidden" onClick={() => setSidebar(true)} aria-label="Open menu">
            ☰
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm text-zinc-200">{active?.name ?? "Flash AI"}</h1>
          <button
            onClick={() => setShowCredits(true)}
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs transition ${
              me.credits < 10
                ? "border-spark/50 bg-spark/10 text-spark-soft hover:bg-spark/20"
                : "border-white/10 text-zinc-200 hover:bg-white/[0.04]"
            }`}
            title="Credits: see costs and top up"
          >
            <BoltIcon className="h-3.5 w-3.5 text-gold" /> {me.credits.toLocaleString()} credits
          </button>
        </header>
        {showCredits && <CreditsDialog me={me} onClose={() => setShowCredits(false)} onChanged={refreshMe} />}
        {showInvite && <InviteDialog me={me} onClose={() => setShowInvite(false)} />}
        <InstallPopup />

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
            {notice && (
              <div
                role="status"
                className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-zinc-100"
              >
                <span className="flex-1">{notice}</span>
                <button onClick={() => setNotice("")} aria-label="Dismiss" className="text-primary-soft hover:text-white">
                  ✕
                </button>
              </div>
            )}
            {me && !me.verified && <VerifyBanner email={me.user.email} free={me.freeMonthly} failed={emailFailed} />}
            {allOff && (
              <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                Flash is taking a short break, so answers are paused and nothing uses credits. Please check back soon.
              </div>
            )}
            {active?.messages && active.messages.length === 0 && (
              <div className="pt-6 text-center sm:pt-12">
                <LogoMark size={64} className="mx-auto mb-6" />
                <p className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-500">{greeting()}</p>
                <h2 className="mt-2 text-4xl font-medium tracking-[-0.04em] text-white sm:text-5xl">
                  Welcome, <span className="text-holo">{firstName(me.user)}</span>
                </h2>
                <p className="mt-3 text-lg font-medium tracking-[-0.01em] text-zinc-300 sm:text-xl">
                  Think it. <span className="text-holo">Flash it.</span>
                </p>
                <p className="mx-auto mt-4 max-w-lg text-zinc-400">
                  Build apps, make slides, write, research, code, translate and crunch spreadsheets
                  {makes.length ? `, and create ${makes.slice(0, -1).join(", ")}${makes.length > 1 ? " and " : ""}${makes.at(-1)}` : ""}.
                  Ask anything and Flash picks the best AI for the job.
                </p>
                <div className="mt-10 grid grid-cols-1 gap-2 text-left sm:grid-cols-2 lg:grid-cols-3">
                  {SUGGESTIONS.filter((s) => isLive(s.engine)).map((s) => (
                    <button
                      key={s.text}
                      onClick={() => (s.engine === "transcribe" ? fileRef.current?.click() : send(s.text))}
                      className="group rounded-xl border border-white/6 bg-white/[0.02] p-3.5 text-left transition hover:border-white/12 hover:bg-white/[0.04]"
                    >
                      <div className="flex items-center gap-2 text-xs text-zinc-400 group-hover:text-primary-soft">
                        <EngineIcon engine={s.engine} size="sm" />
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
                onEdit={m.role === "user" && !busy && i === all.findLastIndex((x) => x.role === "user") ? editLast : undefined}
                onBuyCredits={() => setShowCredits(true)}
                paymentsOn={me.paymentsEnabled || me.testPurchases}
                onPublished={(slug) => setAppSlug(m.id, slug)}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="px-4 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="rounded-[28px] border border-white/10 bg-zinc-900/70 p-2.5 shadow-lg shadow-black/20 transition focus-within:border-white/20"
            >
              {attachment && (
                <div className="mb-1 ml-2 mt-1 inline-flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-200">
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
              <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={onFile} />
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
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
                className="block max-h-48 min-h-[44px] w-full resize-none bg-transparent px-2.5 pb-1 pt-2 text-[15px] outline-none placeholder:text-zinc-500"
                aria-label="Message"
              />
              <div className="mt-1 flex items-center gap-2">
                <PlusMenu onFiles={() => fileRef.current?.click()} onCamera={() => cameraRef.current?.click()} />
                <ToolPicker
                  choice={choice}
                  setChoice={setChoice}
                  isLive={isLive}
                  models={me.models}
                  model={choice === "auto" ? undefined : models[choice]}
                  setModel={(engine, id) => setModels((all) => ({ ...all, [engine]: id }))}
                />
                <div className="ml-auto flex items-center gap-2">
                  <MicButton
                    disabled={busy}
                    onText={(text) => {
                      setInput((v) => (v.trim() ? `${v.trimEnd()} ${text}` : text));
                      inputRef.current?.focus();
                    }}
                    onRecording={(file) => attach(file)}
                  />
                  <SendButton busy={busy} onStop={stop} disabled={!input.trim() && !attachment} />
                </div>
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
