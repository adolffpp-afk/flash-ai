"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Message, type Reshape } from "./Message";
import { AuthScreen } from "./AuthScreen";
import { Landing } from "./Landing";
import { VerifyBanner } from "./VerifyBanner";
import { CreditsDialog } from "./CreditsDialog";
import { InviteDialog } from "./InviteFriends";
import { InstallApp, InstallPopup } from "./InstallApp";
import { ShareDialog } from "./ShareDialog";
import { DownloadChat } from "./DownloadChat";
import { ProjectInstructions } from "./ProjectInstructions";
import { Settings, SKIP_COST_CHECK, type SettingsTab } from "./Settings";
import { Creations } from "./Creations";
import { Companion } from "./Companion";
import { Templates } from "./Templates";
import { MyApps } from "./MyApps";
import { OFFICE_TYPES, officeKind, officeText } from "@/lib/office";
import { MAX_PDF_MB, pdfText } from "@/lib/pdf-text";
import { addAttachment } from "@/lib/attachments";
import { MAX_QUEUE, recentTurns, type CompanionContext } from "@/lib/companion";
import { TEMPLATES, type Template, type TemplateValues } from "@/lib/templates";
import { ENGINES, ENGINE_LABELS, type Attachment, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types";
import { api, newId, type Me, type Pricing, type ProjectSummary, type UIMessage } from "@/lib/store";
import type { ChatHit } from "@/lib/server/search";
import { BoltIcon, Logo, LogoMark } from "@/app/brand";
import { EngineIcon } from "./EngineIcon";
import { MicButton, PlusMenu, SendButton, ToolPicker, type Choice } from "./ComposerTools";
import { photoActionsFor } from "@/lib/photo-actions";

// A project's messages are loaded the first time it is opened.
type Project = ProjectSummary & { messages?: UIMessage[] };
// A request the companion lined up, for the chat it was asked about. "waiting" ones need the user's OK first.
type Queued = { id: string; request: string; projectId: string; waiting?: boolean };

/** Whether the user is typing somewhere else, so finishing a job doesn't pull them away. */
function typingElsewhere(own: Element | null): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === own) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

const skipsCostCheck = () => {
  try {
    return localStorage.getItem(SKIP_COST_CHECK) === "1";
  } catch {
    return false;
  }
};

const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.md,.csv,.txt,.json," +
  "audio/*,video/mp4,video/webm,video/quicktime,.docx,.xlsx,.pptx," +
  Object.keys(OFFICE_TYPES).join(",");
const MAX_FILE_MB = 3;
// Word, Excel and PowerPoint files are read in the browser and only their text is sent.
const MAX_OFFICE_MB = 20;

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

// attach: the card opens the file picker instead of sending its text.
const SUGGESTIONS: { engine: Engine; text: string; attach?: boolean }[] = [
  { engine: "app", text: "Build a habit tracker app with streaks and a weekly chart" },
  { engine: "slides", text: "Make a presentation about the future of solar energy in Africa" },
  { engine: "text", text: "Write a friendly email asking my landlord to fix the heater" },
  { engine: "search", text: "What's the latest news in AI this week?" },
  { engine: "code", text: "Write a Python function that checks if a number is prime" },
  { engine: "translate", text: "Translate 'Welcome to our shop' into French, Spanish and Yoruba" },
  { engine: "docs", text: "Create a monthly budget spreadsheet for a family of four" },
  { engine: "image", text: "Draw a minimalist logo for a coffee shop called Flash Brew" },
  { engine: "video", text: "Make a video of ocean waves at sunset, slow drone shot" },
  { engine: "image", text: "Attach a photo and say what to change: remove the background, make it a cartoon", attach: true },
  { engine: "docs", text: "Snap a receipt, menu or handwritten note and turn it into text or a spreadsheet", attach: true },
  { engine: "video", text: "Make a 1 minute movie about a girl who finds a dragon egg" },
  { engine: "music", text: "Compose an upbeat jingle for a bakery ad" },
  { engine: "voice", text: "Read this aloud: Welcome to Flash, your all-in-one AI." },
  { engine: "transcribe", text: "Attach a recording and get a clean transcript", attach: true },
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
      return { ...m, status: undefined, images: [...(m.images ?? []), { url: e.url, prompt: e.prompt, ...(e.label && { label: e.label }) }] };
    case "video":
      return { ...m, status: undefined, videos: [...(m.videos ?? []), { url: e.url, prompt: e.prompt }] };
    case "audio":
      return { ...m, status: undefined, audio: e.url, audioLabel: e.label };
    case "app":
      return { ...m, status: undefined, app: e.app };
    case "sources":
      return { ...m, sources: e.items };
    case "posts":
      return { ...m, posts: e.posts };
    case "error":
      return { ...m, error: e.message };
    case "done":
      return { ...m, pending: false, status: undefined };
  }
}

/**
 * Phone photos are often larger than Flash accepts, so photos over 2048 pixels or 3 MB are
 * scaled down in the browser first. Anything that can't be read is left as it is.
 */
async function shrinkPhoto(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_FILE_MB * 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

const inflateRaw = async (data: Uint8Array) =>
  new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A Word, Excel or PowerPoint file as a text attachment, or an error to show. */
async function readOffice(file: File, kind: "docx" | "xlsx" | "pptx"): Promise<Attachment | string> {
  if (file.size > MAX_OFFICE_MB * 1024 * 1024) return `Word, Excel and PowerPoint files must be ${MAX_OFFICE_MB} MB or smaller.`;
  try {
    const text = await officeText(new Uint8Array(await file.arrayBuffer()), kind, inflateRaw);
    return { name: file.name, mediaType: "text/plain", data: toBase64(text) };
  } catch {
    return `Couldn't read the text in ${file.name}. If it's an older .doc, .xls or .ppt file, save it as .docx, .xlsx or .pptx first.`;
  }
}

/** A big PDF as a text attachment, read in the browser, or an error to show. */
async function readPdf(file: File): Promise<Attachment | string> {
  if (file.size > MAX_PDF_MB * 1024 * 1024) return `PDFs must be ${MAX_PDF_MB} MB or smaller.`;
  try {
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    }
    const text = await pdfText(new Uint8Array(await file.arrayBuffer()), pdfjs);
    return { name: file.name, mediaType: "text/plain", data: toBase64(text) };
  } catch (e) {
    return e instanceof Error && e.message === "no text found"
      ? `${file.name} looks like scanned pages with no text to read. Attach a smaller copy (under ${MAX_FILE_MB} MB) or photos of the pages instead.`
      : `Couldn't read ${file.name}. Try saving it again as a PDF and attaching that.`;
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
  // Files waiting to be sent with the next message; the first is the main one.
  const [files, setFilesState] = useState<Attachment[]>([]);
  const filesNow = useRef<Attachment[]>([]);
  const setFiles = (next: Attachment[]) => {
    filesNow.current = next;
    setFilesState(next);
  };
  const attachment = files[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [companion, setCompanion] = useState(false);
  // Requests the companion lined up, each run in the chat it was asked about, one after another.
  const [queue, setQueueState] = useState<Queued[]>([]);
  const queueNow = useRef<Queued[]>([]);
  // Next up waits after a request fails, is stopped or needs its price confirmed, until Resume.
  const [queuePaused, setQueuePaused] = useState(false);
  const setQueue = (next: Queued[]) => {
    queueNow.current = next;
    setQueueState(next);
    // An emptied list starts afresh: whatever is added next isn't held by an old pause.
    if (!next.length) setQueuePaused(false);
  };
  // The chat a request is running in right now, which may not be the open one.
  const [runningIn, setRunningIn] = useState("");
  // What the running request was asked to do, where, and when it started, for the companion.
  const jobRef = useRef<{ request: string; startedAt: number; projectId: string } | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [dragging, setDragging] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [chatHits, setChatHits] = useState<ChatHit[]>([]);
  const [showShare, setShowShare] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  // The Settings tab to show, or null when Settings is closed.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [showCreations, setShowCreations] = useState(false);
  // The templates window: "" shows them all, a template's id opens its form.
  const [templates, setTemplates] = useState<string | null>(null);
  const [showApps, setShowApps] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Attachments stay in memory only (too large to save), keyed by user message id, for Retry.
  const filesRef = useRef(new Map<string, Attachment[]>());
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
    // The link in a "new message from your site" email.
    if (params.get("apps")) {
      setShowApps(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
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
    // A connected app (see /connector) links here to get more credits.
    if (params.get("credits") && signedIn) {
      setShowCredits(true);
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
  const runningMsg = runningIn ? projects.find((p) => p.id === runningIn)?.messages?.at(-1) : undefined;

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
      setProjects((list) =>
        list.map((p) => (p.id === id ? { ...p, messages: p.messages ?? project.messages, instructions: project.instructions ?? "" } : p)),
      );
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

  async function createProject(): Promise<Project | null> {
    try {
      const { project } = await api<{ project: ProjectSummary }>("/api/projects", { method: "POST", json: {} });
      const created: Project = { ...project, messages: [] };
      setProjects((list) => [created, ...list]);
      setActiveId(project.id);
      setSidebar(false);
      return created;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't create a project.");
      return null;
    }
  }

  /**
   * Makes a template in its own chat (the open one, if it's still empty), and closes the templates
   * once it's there. Invoices and quotes arrive finished and free, even while Flash works on
   * something else; everything else is sent to the template's engine. False when it couldn't start.
   */
  async function makeTemplate(t: Template, values: TemplateValues, document?: string): Promise<boolean> {
    if (t.engine === "local" ? !document : busy) return false;
    const empty = active?.messages && !active.messages.length && active.id !== runningIn ? active : null;
    const project = empty ?? (await createProject());
    if (!project) return false;
    setTemplates(null);
    const name = t.title(values).slice(0, 60);
    const ask: UIMessage = { id: newId(), role: "user", content: t.request(values) };
    if (t.engine === "local") {
      const made: UIMessage = {
        id: newId(),
        role: "assistant",
        content: document ?? "",
        engine: "docs",
        reason: `Made from the ${t.name} template. The totals are worked out exactly, and it's free.`,
        cost: 0,
        local: true,
      };
      updateProject(project.id, (p) => ({ ...p, name, updated_at: Date.now(), messages: [...(p.messages ?? []), { ...ask, local: true }, made] }));
      return true;
    }
    updateProject(project.id, (p) => ({ ...p, name }));
    void respond(project, [], { ...ask, template: { engine: t.engine, name: t.name, model: t.model } });
    return true;
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

  function togglePin(id: string) {
    const current = projects.find((p) => p.id === id);
    if (!current) return;
    const pinned = !current.pinned;
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, pinned } : p)));
    api(`/api/projects/${id}`, { method: "PUT", json: { pinned } }).catch(() => {
      setProjects((list) => list.map((p) => (p.id === id ? { ...p, pinned: !pinned } : p)));
      setNotice("Couldn't pin that project. Please try again.");
    });
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
    // Nothing of this account keeps running, or runs later for whoever signs in next.
    abortRef.current?.abort();
    jobRef.current = null;
    setQueue([]);
    setQueuePaused(false);
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

  // auto: a one-tap button that knows its job, so it goes to Auto whatever tool is picked.
  async function send(text: string, auto = false) {
    if (busy) return;
    if (!active?.messages) {
      if (active) setNotice("This project didn't load. Pick it again in the sidebar.");
      return;
    }
    const content = text.trim();
    if (!content && !attachment) return;
    const userMsg: UIMessage = {
      id: newId(),
      role: "user",
      content,
      attachmentName: files.map((f) => f.name).join(", ") || undefined,
      ...(auto && { auto: true }),
    };
    if (files.length) filesRef.current.set(userMsg.id, files);
    updateProject(active.id, (p) => ({
      ...p,
      name: !p.messages?.length && p.name === "New project" ? content.slice(0, 40) || p.name : p.name,
    }));
    setInput("");
    setFiles([]);
    await respond(active, active.messages ?? [], userMsg);
  }

  /** Answers the last user message again, replacing the reply after it. */
  async function retry(confirmed = false) {
    const messages = active?.messages;
    if (!active || !messages || busy) return;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    if (lastUser === -1) return;
    await respond(active, messages.slice(0, lastUser), messages[lastUser], confirmed);
  }

  /** Agrees to a costly request's price and runs it; "always" stops asking on this device. */
  function confirmCost(always: boolean) {
    if (always) {
      try {
        localStorage.setItem(SKIP_COST_CHECK, "1");
      } catch {}
    }
    retry(true);
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

  async function respond(project: Project, earlier: UIMessage[], userMsg: UIMessage, confirmed = false) {
    const projectId = project.id;
    const reply: UIMessage = { id: newId(), role: "assistant", content: "", pending: true };
    const sent = filesRef.current.get(userMsg.id) ?? [];
    // A template's request always goes to its own engine, and one the companion lined up to Auto
    // (the tool picked in the composer was for something else); anything else to the one picked.
    const engine = userMsg.template?.engine ?? (userMsg.queued || userMsg.auto ? "auto" : choice);

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
      { role: "user", content: userMsg.content, attachment: sent[0], more: sent.length > 1 ? sent.slice(1) : undefined },
    ];

    updateProject(projectId, (p) => ({ ...p, updated_at: Date.now(), messages: [...earlier, userMsg, reply] }));
    jobRef.current = { request: userMsg.content, startedAt: Date.now(), projectId };
    setRunningIn(projectId);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let finished = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          engine,
          preferences,
          previous,
          model: userMsg.template?.model ?? (engine === "auto" ? undefined : models[engine]),
          template: userMsg.template?.name,
          confirmed: confirmed || skipsCostCheck(),
          projectId,
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
          if (e.type === "error") finished = false;
          updateMessage(projectId, reply.id, (m) => applyEvent(m, e));
        }
      }
    } catch (err) {
      finished = false;
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
      jobRef.current = null;
      // A request that failed, was stopped or waits for its price to be confirmed holds Next up,
      // so nothing runs on top of it until the user says so.
      if (!finished && queueNow.current.length) setQueuePaused(true);
      setRunningIn("");
      setBusy(false);
      if (!typingElsewhere(inputRef.current)) inputRef.current?.focus();
    }
  }

  /**
   * Runs each request the companion lined up, as soon as Flash is free, in the chat it was asked
   * about (even if another chat is open now). It never takes the composer's text or files.
   */
  useEffect(() => {
    if (busy || queuePaused || !queue.length || queue[0].waiting) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    const project = projects.find((p) => p.id === next.projectId);
    if (!project?.messages) {
      setNotice(`"${next.request.slice(0, 60)}" didn't run: its chat couldn't be found.`);
      return;
    }
    updateProject(project.id, (p) => ({
      ...p,
      name: !p.messages?.length && p.name === "New project" ? next.request.slice(0, 40) : p.name,
    }));
    respond(project, project.messages, { id: newId(), role: "user", content: next.request, queued: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queuePaused, queue, projects]);

  /**
   * Adds a request the companion lined up to Next up, for the chat Flash is working in (or the
   * open one). "waiting" requests only run once the user presses Run.
   */
  const queueRequest = useCallback(
    (request: string, waiting = false) => {
      const projectId = jobRef.current?.projectId ?? activeId;
      if (!projectId) return;
      const list = queueNow.current;
      if (list.some((q) => q.request === request && q.projectId === projectId)) return;
      if (list.length >= MAX_QUEUE) {
        setNotice(`Next up is full at ${MAX_QUEUE} requests. They run one after another, then you can add more.`);
        return;
      }
      setQueue([...list, { id: newId(), request, projectId, waiting }]);
    },
    [activeId],
  );

  /** What the companion is told about the user's work when they ask it something. */
  const companionContext = useCallback(
    (): CompanionContext => {
      const job = jobRef.current;
      // While a job runs, the companion hears about the chat it runs in, even if another one is open.
      const chat = (job && projects.find((p) => p.id === job.projectId)) || active;
      const running = chat?.messages?.at(-1);
      const now = new Date();
      return {
        project: chat?.name,
        today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        ...(job && {
          job: {
            engine: running?.engine,
            model: running?.model,
            status: running?.status,
            seconds: Math.round((Date.now() - job.startedAt) / 1000),
            request: job.request,
          },
        }),
        recent: recentTurns(chat?.messages ?? []),
        queue: queueNow.current.map((q) => q.request),
      };
    },
    [active, projects],
  );

  /** Opens whatever page the companion was asked to open. */
  const openCompanionPage = useCallback(
    (page: string) => {
      const tabs = ["memory", "brand", "plan", "apps", "preferences", "account"];
      if (page === "settings") setSettingsTab("profile");
      else if (tabs.includes(page)) setSettingsTab(page as SettingsTab);
      else if (page === "credits") setShowCredits(true);
      else if (page === "invite") setShowInvite(true);
      else if (page === "creations") setShowCreations(true);
      else if (page === "websites") setShowApps(true);
      else if (page === "instructions") setShowInstructions(true);
      else if (page === "templates") setTemplates("");
      setSidebar(false);
    },
    [],
  );

  /** Makes a picture again in another shape (the shape words are read by the image engine). */
  function reshape(prompt: string, shape: Reshape) {
    const how = { tall: "tall vertical 9:16", square: "square 1:1", wide: "wide 16:9" }[shape];
    send(`Make a ${how} picture of this: ${prompt}`);
  }

  /** Puts a picture Flash made into the composer, so the photo buttons and edits apply to it. */
  async function editImage(url: string) {
    try {
      const blob = await (await fetch(url)).blob();
      const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      // The picture replaces any files waiting, so the photo buttons apply to it.
      setFiles([]);
      await attach(new File([blob], `flash-picture.${ext}`, { type: blob.type || "image/png" }));
      setInput("");
    } catch {
      setNotice("Couldn't open that picture. Download it and attach it with the + button instead.");
    }
  }

  const closeSettings = useCallback(() => setSettingsTab(null), []);
  const closeTemplates = useCallback(() => setTemplates(null), []);

  /** Adds a read file to the ones waiting to be sent, or says why it can't be added. */
  function addFile(file: Attachment) {
    const added = addAttachment(filesNow.current, file);
    if ("error" in added) return setNotice(added.error);
    setFiles(added.files);
    inputRef.current?.focus();
  }

  /** Reads and adds files one after another, so each one's checks see the ones before it. */
  async function attachAll(list: FileList | File[] | null | undefined) {
    for (const file of [...(list ?? [])]) await attach(file);
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    if (/\.(doc|xls|ppt)$/i.test(file.name)) {
      setNotice(`${file.name} is an older Office file. Save it as .docx, .xlsx or .pptx first, then attach it.`);
      return;
    }
    const office = officeKind(file.name, file.type);
    if (office) {
      const read = await readOffice(file, office);
      if (typeof read === "string") setNotice(read);
      else addFile(read);
      return;
    }
    // Small PDFs go whole, so Flash sees their pictures too; bigger ones send only their text.
    if ((file.type === "application/pdf" || /\.pdf$/i.test(file.name)) && file.size > MAX_FILE_MB * 1024 * 1024) {
      setNotice(`Reading ${file.name}…`);
      const read = await readPdf(file);
      if (typeof read === "string") setNotice(read);
      else {
        setNotice("");
        addFile(read);
      }
      return;
    }
    file = await shrinkPhoto(file);
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert(`Files must be ${MAX_FILE_MB} MB or smaller.`);
      return;
    }
    // Audio and video files go to Transcribe, so say so up front when it isn't available yet.
    if (/^(audio|video)\//.test(file.type) && status && !status.transcribe) {
      setNotice("Transcribing audio and video isn't available yet. It's coming soon.");
      return;
    }
    addFile(await readFile(file));
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const list = [...(e.target.files ?? [])];
    e.target.value = "";
    attachAll(list);
  }

  // Looks inside the chats too, a moment after typing stops.
  useEffect(() => {
    const q = projectQuery.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      api<{ results: ChatHit[] }>(`/api/projects/search?q=${encodeURIComponent(q)}`)
        .then(({ results }) => setChatHits(results))
        .catch(() => setChatHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [projectQuery]);

  const sorted = [...projects]
    .filter((p) => !projectQuery.trim() || p.name.toLowerCase().includes(projectQuery.trim().toLowerCase()))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated_at - a.updated_at);
  const inChats = projectQuery.trim().length >= 2 ? chatHits.filter((h) => h.snippet && !sorted.some((p) => p.id === h.id)) : [];
  // Engines whose AI provider isn't set up yet show as coming soon, and light up once /api/status says so.
  const isLive = (e: Engine) => !status || status[e];
  // The one-tap buttons for attached photos (Copy the text, Remove background…).
  const photoActions = photoActionsFor(files.map((f) => f.mediaType), isLive);
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
          <button
            onClick={() => {
              setShowCreations(true);
              setSidebar(false);
            }}
            className="mt-1.5 h-9 w-full rounded-lg px-3 text-left text-sm text-zinc-300 transition hover:bg-white/[0.04] hover:text-white"
          >
            🖼️ My creations
          </button>
          <button
            onClick={() => {
              setShowApps(true);
              setSidebar(false);
            }}
            className="mt-0.5 h-9 w-full rounded-lg px-3 text-left text-sm text-zinc-300 transition hover:bg-white/[0.04] hover:text-white"
          >
            🌐 My websites &amp; apps
          </button>
          <button
            onClick={() => {
              setTemplates("");
              setSidebar(false);
            }}
            className="mt-0.5 h-9 w-full rounded-lg px-3 text-left text-sm text-zinc-300 transition hover:bg-white/[0.04] hover:text-white"
          >
            📋 Templates
          </button>
          <button
            onClick={() => {
              setSettingsTab("brand");
              setSidebar(false);
            }}
            className="mt-0.5 h-9 w-full rounded-lg px-3 text-left text-sm text-zinc-300 transition hover:bg-white/[0.04] hover:text-white"
          >
            🎨 Brand kit
          </button>
        </div>
        {projects.length > 1 && (
          <div className="mt-3 px-3">
            <input
              type="search"
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              placeholder="Search projects and chats"
              aria-label="Search projects and chats"
              className="h-9 w-full rounded-lg border border-white/8 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-primary/70"
            />
          </div>
        )}
        <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3">
          {projectQuery.trim() && !sorted.length && !inChats.length && <p className="px-2 py-1.5 text-xs text-zinc-500">Nothing matches.</p>}
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center rounded-lg text-sm ${p.id === activeId ? "bg-white/[0.06] text-white" : "text-zinc-300 hover:bg-white/[0.03]"}`}
            >
              <button className="min-w-0 flex-1 truncate px-3 py-1.5 text-left" onClick={() => openProject(p.id)}>
                {p.pinned && (
                  <span className="mr-1.5 text-[11px]" aria-label="Pinned">
                    📌
                  </span>
                )}
                {p.name}
              </button>
              <button
                className="px-1 text-zinc-500 hover:text-zinc-200 focus:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                onClick={() => togglePin(p.id)}
                aria-label={p.pinned ? "Unpin project" : "Pin project"}
                title={p.pinned ? "Unpin" : "Pin to the top"}
              >
                {p.pinned ? "⊘" : "📌"}
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
          {inChats.length > 0 && (
            <>
              <p className="px-2 pt-3 pb-1 text-xs font-medium text-zinc-500">In your chats</p>
              {inChats.map((h) => (
                <button
                  key={h.id}
                  onClick={() => openProject(h.id)}
                  className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition ${h.id === activeId ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
                >
                  <span className="block truncate text-zinc-200">{h.name}</span>
                  <span className="line-clamp-2 text-xs text-zinc-500">
                    {h.role === "user" ? "You: " : "Flash: "}
                    {h.snippet}
                  </span>
                </button>
              ))}
            </>
          )}
        </nav>
        <div className="border-t border-white/6 p-3">
          <button
            onClick={() => setShowInvite(true)}
            className="w-full rounded-lg border border-white/8 px-2 py-1.5 text-left text-xs text-gold-soft transition hover:bg-white/[0.04] hover:text-gold"
          >
            🎁 Invite friends, earn credits
          </button>
          <InstallApp className="mt-2 flex w-full items-center gap-2 rounded-lg border border-white/8 px-2 py-1.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.04] hover:text-white" />
          {status && (
            <details className="mt-2 text-xs text-zinc-400">
              <summary className="cursor-pointer select-none hover:text-zinc-200">
                {liveCount === ENGINES.length ? "✨ What Flash can do" : `✨ What Flash can do · ${ENGINES.length - liveCount} coming soon`}
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
            <button
              onClick={() => {
                setSettingsTab("profile");
                setSidebar(false);
              }}
              className="rounded-md px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100"
              title="Settings: profile, memory, brand kit, plan, connected apps"
            >
              ⚙️ Settings
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
          attachAll(e.dataTransfer.files);
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
          {active?.messages && (
            <button
              onClick={() => setShowInstructions(true)}
              title={active.instructions ? `Instructions: ${active.instructions.slice(0, 120)}` : "Tell Flash how to answer in this project"}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${
                active.instructions ? "border-primary/40 bg-primary/10 text-primary-soft hover:bg-primary/20" : "border-white/10 text-zinc-200 hover:bg-white/[0.05]"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 6h16 M4 12h10 M4 18h7 M17 15l2 2 4-4" />
              </svg>
              <span className="hidden sm:inline">{active.instructions ? "Instructions on" : "Instructions"}</span>
            </button>
          )}
          {active?.messages?.some((m) => !m.pending) && <DownloadChat project={active} disabled={busy} />}
          {active?.messages?.some((m) => !m.pending) && (
            <button
              onClick={() => setShowShare(true)}
              disabled={busy}
              title="Share a link to this chat"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 15V3 M7 8l5-5 5 5 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>
              Share
            </button>
          )}
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
        {showApps && (
          <MyApps
            onClose={() => setShowApps(false)}
            onEdit={(id) => {
              setShowApps(false);
              setNotice("Ask for your changes here, then press Update site under the new version.");
              openProject(id);
            }}
          />
        )}
        {showCreations && (
          <Creations
            onClose={() => setShowCreations(false)}
            onUseImage={
              busy
                ? undefined
                : (url) => {
                    setShowCreations(false);
                    editImage(url);
                  }
            }
          />
        )}
        {templates !== null && (
          <Templates
            userId={me.user.id}
            costs={me.costs}
            written={me.templates}
            initialId={templates || undefined}
            isLive={isLive}
            busy={busy}
            onMake={makeTemplate}
            onClose={closeTemplates}
          />
        )}
        {showCredits && <CreditsDialog me={me} onClose={() => setShowCredits(false)} onChanged={refreshMe} />}
        {showInvite && <InviteDialog me={me} onClose={() => setShowInvite(false)} />}
        <InstallPopup />
      {showShare && active && <ShareDialog project={active} onClose={() => setShowShare(false)} />}
      {settingsTab && me && (
        <Settings
          me={me}
          preferences={preferences}
          initialTab={settingsTab}
          onPreferences={changePreferences}
          onNameChanged={(name) => setMe((m) => (m ? { ...m, user: { ...m.user, name } } : m))}
          onOpenCredits={() => {
            setSettingsTab(null);
            setShowCredits(true);
          }}
          onOpenInvite={() => {
            setSettingsTab(null);
            setShowInvite(true);
          }}
          onSignOut={() => {
            setSettingsTab(null);
            signOut();
          }}
          onClose={closeSettings}
        />
      )}
      {showInstructions && active && (
        <ProjectInstructions
          project={active}
          onSaved={(instructions) => setProjects((list) => list.map((p) => (p.id === active.id ? { ...p, instructions } : p)))}
          onClose={() => setShowInstructions(false)}
        />
      )}

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
                <div className="mt-8 flex flex-wrap items-center justify-center gap-2" aria-label="Start from a template">
                  {TEMPLATES.filter((t) => ["business-plan", "resume", "social-pack", "flyer", "invoice"].includes(t.id))
                    .filter((t) => t.engine === "local" || isLive(t.engine))
                    .map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setTemplates(t.id)}
                        className="rounded-full border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:border-primary/50 hover:bg-white/[0.04]"
                      >
                        <span aria-hidden>{t.icon}</span> {t.name}
                      </button>
                    ))}
                  <button
                    onClick={() => setTemplates("")}
                    className="rounded-full px-3 py-1.5 text-sm text-primary-soft transition hover:text-white"
                  >
                    All templates →
                  </button>
                </div>
                <div className="mt-8 grid grid-cols-1 gap-2 text-left sm:grid-cols-2 lg:grid-cols-3">
                  {SUGGESTIONS.filter((s) => isLive(s.engine)).map((s) => (
                    <button
                      key={s.text}
                      onClick={() => (s.attach ? fileRef.current?.click() : send(s.text))}
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
                onRetry={i === all.length - 1 && m.role === "assistant" && !m.pending && !m.local && !busy ? () => retry() : undefined}
                onConfirmCost={i === all.length - 1 && !busy ? confirmCost : undefined}
                onEdit={m.role === "user" && !m.local && !busy && i === all.findLastIndex((x) => x.role === "user") ? editLast : undefined}
                onBuyCredits={() => setShowCredits(true)}
                paymentsOn={me.paymentsEnabled || me.testPurchases}
                onPublished={(slug) => setAppSlug(m.id, slug)}
                publishedEarlier={m.app && !m.app.slug ? all.slice(0, i).findLast((x) => x.app?.slug)?.app?.slug : undefined}
                onUseImage={busy ? undefined : editImage}
                onReshape={busy || attachment || all[i - 1]?.attachmentName ? undefined : reshape}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="px-4 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            {queue.length > 0 && (
              <div className="mb-2 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 text-xs font-medium text-zinc-400">
                    Next up · {queue.length} {queue.length === 1 ? "request" : "requests"}{" "}
                    {queuePaused
                      ? "paused, because the last request didn't finish"
                      : queue[0].waiting
                        ? "waiting for your OK"
                        : busy
                          ? "waiting for this one to finish"
                          : "starting now"}
                  </p>
                  {queuePaused && (
                    <button
                      type="button"
                      onClick={() => setQueuePaused(false)}
                      aria-label="Resume Next up"
                      className="shrink-0 rounded-full bg-primary/20 px-2.5 py-0.5 text-xs text-primary-soft hover:bg-primary/30"
                    >
                      Resume
                    </button>
                  )}
                </div>
                <ul className="mt-1.5 space-y-1">
                  {queue.map((q, i) => {
                    const elsewhere = q.projectId !== activeId ? projects.find((p) => p.id === q.projectId)?.name : undefined;
                    return (
                      <li key={q.id} className="flex items-start gap-2 text-sm text-zinc-200">
                        <span className="mt-0.5 shrink-0 text-xs text-zinc-500">{i + 1}.</span>
                        <span className="min-w-0 flex-1 truncate">
                          {q.request}
                          {elsewhere && <span className="text-xs text-zinc-500"> · in {elsewhere}</span>}
                        </span>
                        {q.waiting && (
                          <button
                            type="button"
                            onClick={() => setQueue(queueNow.current.map((x) => (x.id === q.id ? { ...x, waiting: false } : x)))}
                            aria-label={`Run "${q.request}"`}
                            className="shrink-0 rounded-full bg-primary/20 px-2 text-xs leading-5 text-primary-soft hover:bg-primary/30"
                          >
                            Run
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setQueue(queueNow.current.filter((x) => x.id !== q.id))}
                          aria-label={`Remove "${q.request}" from Next up`}
                          className="shrink-0 text-zinc-500 hover:text-red-400"
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="rounded-[28px] border border-white/10 bg-zinc-900/70 p-2.5 shadow-lg shadow-black/20 transition focus-within:border-white/20"
            >
              {files.length > 0 && (
                <div className="mb-1 ml-2 mt-1 flex flex-wrap gap-1.5">
                  {files.map((f) => (
                    <div key={f.name} className="inline-flex max-w-full items-center gap-2 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-200">
                      <span className="truncate">📎 {f.name}</span>
                      <button
                        type="button"
                        onClick={() => setFiles(filesNow.current.filter((x) => x !== f))}
                        aria-label={`Remove ${f.name}`}
                        className="text-zinc-400 hover:text-zinc-100"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {photoActions.length > 0 && !busy && (
                <div className="mb-1 ml-2 mt-1 inline-flex flex-wrap gap-1.5">
                  {photoActions.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      onClick={() => send(files.length > 1 ? a.several! : a.prompt, true)}
                      className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 transition hover:border-primary/50 hover:text-zinc-100"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={onFile} />
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const pasted = [...e.clipboardData.files];
                  if (pasted.length) {
                    e.preventDefault();
                    attachAll(pasted);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                placeholder={
                  photoActions.length
                    ? files.length > 1
                      ? "Ask about these photos, or tap a button above…"
                      : "Ask about it, say what to change, or tap a button above…"
                    : choice === "auto"
                      ? "Ask Flash anything…"
                      : `Ask ${ENGINE_LABELS[choice]}…`
                }
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

      <Companion
        open={companion}
        onOpen={() => setCompanion(true)}
        onClose={() => setCompanion(false)}
        context={companionContext}
        onQueue={queueRequest}
        onPage={openCompanionPage}
        onCost={refreshMe}
        running={busy ? { engine: runningMsg?.engine, status: runningMsg?.status } : null}
      />
    </div>
  );
}
