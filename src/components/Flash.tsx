"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Message, type Reshape } from "./Message";
import { AuthScreen } from "./AuthScreen";
import { Landing } from "./Landing";
import { VerifyBanner } from "./VerifyBanner";
import { CreditsDialog } from "./CreditsDialog";
import { InviteDialog } from "./InviteFriends";
import { InstallPopup } from "./InstallApp";
import { ShareDialog } from "./ShareDialog";
import { DownloadChat } from "./DownloadChat";
import { ProjectInstructions } from "./ProjectInstructions";
import { Settings, SKIP_COST_CHECK, settingsTabFor, type SettingsTab } from "./Settings";
import { AccountMenu } from "./AccountMenu";
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
import { BoltIcon, BrandMark } from "@/app/brand";
import { Greeting, Home, ICONS, Icon } from "./Home";
import { Bell } from "./Bell";
import { EngineIcon } from "./EngineIcon";
import { LevelPicker, MenusOpenDown, MicButton, PlusMenu, SendButton, TalkButton, ToolPicker, type Choice } from "./ComposerTools";
import { VoiceMode, type VoiceAnswer } from "./VoiceMode";
import { useWakeWord } from "./useWakeWord";
import { voiceReply } from "@/lib/voice-chat";
import { photoActionsFor } from "@/lib/photo-actions";
import { pickedContext, type PickedElement } from "@/lib/preview-bridge";
import { pictureFollowUp } from "@/lib/router";
import { firstName } from "@/lib/names";
import { timeAgo } from "@/lib/when";
import { applyAppearance, applyTheme, notifiesWhenDone, readSetting, writeSetting } from "@/lib/device-settings";
import { LEVEL_ENGINES, isLevel, type Level } from "@/lib/levels";

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

/** Tools that change a picture: a follow-up like "make it darker" goes with the picture above only to these. */
const changesPictures = (choice: Choice) => choice === "auto" || choice === "image" || choice === "video";

/** The picture Flash made in its last reply, when there is exactly one, for follow-ups like "add a hat". */
function pictureAbove(messages: UIMessage[] | undefined): string | null {
  const last = messages?.findLast((m) => m.role === "assistant");
  return last && !last.pending && !last.error && last.images?.length === 1 ? last.images[0].url : null;
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

/** A message as the AI reads it: with text that came after an app, and the part of the app it's about. */
function turnText(m: UIMessage): string {
  const text = m.content + (m.after ?? "");
  return m.picked ? `${text}\n\n${m.picked.context}` : text;
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

/**
 * The picture above that a request goes with, by the same rule wherever it's sent from (typed,
 * Next up, Talk or an edited message): Flash's last reply is one picture, the words read as a change
 * to it ("make it darker"), the tool can change pictures, and the user didn't tap ✕ to keep it.
 */
function followUpPicture(messages: UIMessage[] | undefined, text: string, tool: Choice, keep: string | null = null): string | null {
  const above = pictureAbove(messages);
  return above && above !== keep && changesPictures(tool) && pictureFollowUp(text) ? above : null;
}

/** A request going with the picture above, when there is one to go with. */
const withPicture = (m: UIMessage, url: string | null): UIMessage =>
  url ? { ...m, attachmentName: "The picture above", pictureAbove: url } : m;

// Nothing is sent without the files a request goes with: the words alone would make something else.
const NO_PICTURE = "Couldn't open the picture above, so nothing was sent and no credits were used. Try again in a moment.";
const NO_FILES = "Attached files aren't kept once Flash is reloaded, so nothing was sent. Attach them again and send your message.";

/** The picture above, ready to send with a follow-up, scaled down the way an attached photo is. */
async function pictureAttachment(url: string, signal?: AbortSignal): Promise<Attachment | null> {
  try {
    const res = await fetch(url, { signal });
    const blob = await res.blob();
    if (!res.ok || !/^image\//.test(blob.type)) return null;
    const ext = blob.type.split("/")[1].replace("jpeg", "jpg");
    const file = await shrinkPhoto(new File([blob], `picture-above.${ext}`, { type: blob.type }));
    return file.size <= MAX_FILE_MB * 1024 * 1024 ? await readFile(file) : null;
  } catch {
    return null;
  }
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
  // A part of the latest app the user picked in its preview; the next message says what to change about it.
  const [picked, setPicked] = useState<{ projectId: string; kind: "app" | "slides"; label: string; context: string } | null>(null);
  const [choice, setChoice] = useState<Choice>("auto");
  // The picture above that the user said not to change (the ✕ on "Changing the picture above").
  const [keepPicture, setKeepPicture] = useState<string | null>(null);
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
  // The Ask Flash button can be hidden in Settings > Capabilities (read after mount: it lives on the device).
  const [hideCompanion, setHideCompanion] = useState(false);
  // A voice conversation, docked where the message box is; woke when "Hey Flash" opened it.
  const [voice, setVoice] = useState<{ woke: boolean; first?: string } | null>(null);
  // "Hey Flash" is on for this device (Settings > General > Voice), and whether the mic button is listening.
  const [wakeOn, setWakeOn] = useState(false);
  // Flash's level of intelligence, kept on this device (see levels.ts).
  const [level, setLevelState] = useState<Level>("auto");
  const setLevel = (next: Level) => {
    setLevelState(next);
    writeSetting("level", next === "auto" ? "" : next);
  };
  const [dictating, setDictating] = useState(false);
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
  // The search box at the top of Home, its list of matches, and the sidebar's (on phones and in chats).
  // "all" when opened from Home's View all, which lists every chat instead of the latest 10.
  const [searchOpen, setSearchOpen] = useState<boolean | "all">(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const sideSearchRef = useRef<HTMLInputElement>(null);
  // Macs show ⌘ K for search, other computers Ctrl K (read after mount).
  const [mac, setMac] = useState(false);
  const [chatHits, setChatHits] = useState<ChatHit[]>([]);
  const [showShare, setShowShare] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  // The Settings tab to show, or null when Settings is closed.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [showCreations, setShowCreations] = useState<"" | "all" | "image">("");
  // The templates window: "" shows them all, a template's id opens its form.
  const [templates, setTemplates] = useState<string | null>(null);
  const [showApps, setShowApps] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // A request is starting or running. Set at once, before busy shows or the picture above loads,
  // so a second Enter or tap in the meantime does nothing.
  const runningRef = useRef(false);
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
      // Flash opens on Home, which greets the user and lists their latest chats.
      const { projects: list } = await api<{ projects: ProjectSummary[] }>("/api/projects");
      setProjects(list);
      setActiveId("");
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

  // Settings kept on this device: the chat font and text size, and whether Ask Flash shows.
  useEffect(() => {
    applyAppearance();
    applyTheme();
    setHideCompanion(readSetting("hideCompanion") === "1");
    setWakeOn(readSetting("wakeWord") === "1");
    const saved = readSetting("level");
    if (isLevel(saved)) setLevelState(saved);
  }, []);

  // ⌘ K or Ctrl K jumps to search: the box at the top of Home, or the sidebar's elsewhere.
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    setMac(isMac);
    const onKey = (e: KeyboardEvent) => {
      // Cmd on a Mac (Ctrl K there deletes to the end of the line), and never from behind an open dialog.
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.key.toLowerCase() !== "k" || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      if (searchRef.current?.offsetParent) return searchRef.current.focus();
      if (!sideSearchRef.current?.offsetParent) setSidebar(true);
      setTimeout(() => sideSearchRef.current?.focus(), 50);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The search list closes on Escape or a click elsewhere.
  useEffect(() => {
    if (!searchOpen) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !searchBoxRef.current?.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [searchOpen]);

  // "Hey Flash" listens while Flash is open, except while the mic button or a conversation is listening.
  const wakeState = useWakeWord(wakeOn && !voice && !dictating && Boolean(me) && !signedOut, (rest) =>
    setVoice({ woke: true, first: rest }),
  );

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

  /** Back to Home; the next message starts a new chat. */
  function goHome() {
    setActiveId("");
    setSidebar(false);
  }

  /** AI Chat in the sidebar: the latest chat, or the message box on Home when there's none yet. */
  function openChats() {
    if (active?.messages?.length) return;
    // Skips chats with nothing in them yet (the loaded messages say, else the list's empty flag).
    const latest = [...projects].filter((p) => (p.messages ? p.messages.length > 0 : !p.empty)).sort((a, b) => b.updated_at - a.updated_at)[0];
    if (latest) openProject(latest.id);
    else pickTool("auto");
  }

  /** Picks a tool in the message box and puts the cursor there, as Home's tool buttons do. */
  function pickTool(next: Choice) {
    setVoice(null);
    setChoice(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /** Home's View all: the search list on computers, the sidebar on phones. */
  function viewAllChats() {
    if (searchRef.current?.offsetParent) {
      searchRef.current.focus();
      setSearchOpen("all");
    } else setSidebar(true);
  }

  function openFromSearch(id: string) {
    setSearchOpen(false);
    setProjectQuery("");
    openProject(id);
  }

  /**
   * Makes a template in its own chat (the open one, if it's still empty), and closes the templates
   * once it's there. Invoices and quotes arrive finished and free, even while Flash works on
   * something else; everything else is sent to the template's engine. False when it couldn't start.
   */
  async function makeTemplate(t: Template, values: TemplateValues, document?: string): Promise<boolean> {
    if (t.engine === "local" ? !document : busy || runningRef.current) return false;
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
    setProjects((list) => list.filter((p) => p.id !== id));
    if (id === activeId) setActiveId("");
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

  // everywhere: Settings already signed out every device, this one included.
  async function signOut(everywhere = false) {
    if (!everywhere) await api("/api/auth/logout", { method: "POST" }).catch(() => {});
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

  /** Saves code the user changed by hand as that version's code, so Flash builds on it next. */
  function editAppCode(messageId: string, html: string) {
    if (active) updateMessage(active.id, messageId, (m) => (m.app ? { ...m, app: { ...m.app, html } } : m));
  }

  /** Asks the builder to fix what went wrong in the latest app's preview. */
  async function fixApp(kind: "app" | "slides", request: string) {
    if (!active?.messages || busy || runningRef.current) return;
    await respond(active, active.messages, { id: newId(), role: "user", content: request, build: kind });
  }

  /** Puts a part picked in the latest app's preview above the message box, to say what to change. */
  function pickApp(kind: "app" | "slides", part: PickedElement) {
    if (!active) return;
    setPicked({ projectId: active.id, kind, label: part.label, context: pickedContext(part) });
    inputRef.current?.focus();
  }

  /**
   * The open chat, or on Home a new one for the first message. Nothing else can start while it's
   * being made, so a second Enter doesn't make a second chat.
   */
  async function ensureChat(): Promise<Project | null> {
    if (active) return active;
    runningRef.current = true;
    const made = await createProject();
    runningRef.current = false;
    return made;
  }

  // auto: a one-tap button that knows its job, so it goes to Auto whatever tool is picked.
  // fresh: asks for a new picture (Tall, Square, Wide), so it never goes with the picture above.
  async function send(text: string, auto = false, fresh = false) {
    if (busy || runningRef.current) return;
    const content = text.trim();
    if (!content && !attachment) return;
    const chat = await ensureChat();
    if (!chat) return;
    if (!chat.messages) {
      setNotice("This project didn't load. Pick it again in the sidebar.");
      return;
    }
    const part = picked?.projectId === chat.id ? picked : null;
    // "Make it darker" right after a picture changes that picture, the way ChatGPT does.
    const above = !files.length && !part && !auto && !fresh ? followUpPicture(chat.messages, content, choice, keepPicture) : null;
    const userMsg = withPicture(
      {
        id: newId(),
        role: "user",
        content,
        attachmentName: files.map((f) => f.name).join(", ") || undefined,
        ...(auto && { auto: true }),
        ...(part && { build: part.kind, picked: { label: part.label, context: part.context } }),
      },
      above,
    );
    // The box is cleared at once, so nothing typed or attached while the picture above loads is lost.
    setPicked(null);
    setKeepPicture(null);
    if (files.length) filesRef.current.set(userMsg.id, files);
    updateProject(chat.id, (p) => ({
      ...p,
      name: !p.messages?.length && p.name === "New project" ? content.slice(0, 40) || p.name : p.name,
    }));
    setInput("");
    setFiles([]);
    await respond(chat, chat.messages, userMsg, false, (stopped) => {
      // The picture above couldn't be opened (or Stop was pressed while it loaded), so nothing was
      // sent: the words go back in the box and the user decides.
      setInput((typed) => (typed.trim() ? typed : text));
      if (!stopped) setNotice("Couldn't open the picture above. Tap ✕ to make a new picture instead.");
    });
  }

  /** Answers the last user message again, replacing the reply after it. Returns the new reply. */
  async function retry(confirmed = false): Promise<UIMessage | null> {
    const messages = active?.messages;
    if (!active || !messages || busy || runningRef.current) return null;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    if (lastUser === -1) return null;
    return respond(active, messages.slice(0, lastUser), messages[lastUser], confirmed);
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
    if (!active || !messages || busy || runningRef.current) return;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    if (lastUser === -1) return;
    const earlier = messages.slice(0, lastUser);
    const { pictureAbove: had, ...old } = messages[lastUser];
    let edited: UIMessage = { ...old, content: text };
    // The new words decide whether it goes with the picture above, as when typing. Files sent with
    // it stay, and a change the user sent without the picture (the ✕) doesn't gain it.
    if (had || (!old.attachmentName && !old.build && !old.template && !pictureFollowUp(old.content))) {
      const url = followUpPicture(earlier, text, old.queued || old.auto ? "auto" : choice);
      if (!url) filesRef.current.delete(old.id);
      edited = withPicture({ ...edited, attachmentName: undefined }, url);
    }
    // When nothing could be sent, the edited words go back in the box rather than being lost.
    await respond(active, earlier, edited, false, (stopped, why) => {
      setInput((typed) => (typed.trim() ? typed : text));
      if (!stopped) setNotice(why);
    });
  }

  function stop() {
    abortRef.current?.abort();
  }

  /** A notification when a long request ends while Flash is in the background (Settings > General). */
  function notifyDone(request: string, ok: boolean, startedAt: number) {
    if (!notifiesWhenDone() || !document.hidden || Date.now() - startedAt < 8000) return;
    try {
      const body = request.length > 90 ? `${request.slice(0, 90)}…` : request;
      new Notification(ok ? "Flash is done" : "Flash stopped", { body: body || "Your request", icon: "/app-icon/192", tag: "flash-done" });
    } catch {}
  }

  /**
   * Sends a request and streams the reply into the chat. Returns the finished reply (for voice
   * conversations), or null while another request is starting. When nothing could be sent (Stop
   * while the picture above loaded, or its files are gone) the chat stays as it was, unsent is
   * called (or a notice says why) and the returned reply says why.
   */
  async function respond(
    project: Project,
    earlier: UIMessage[],
    userMsg: UIMessage,
    confirmed = false,
    unsent?: (stopped: boolean, why: string) => void,
  ): Promise<UIMessage | null> {
    // One request at a time: Flash shows it's busy and Stop works from the first tap.
    if (runningRef.current) return null;
    runningRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const projectId = project.id;
    const startedAt = Date.now();
    const reply: UIMessage = { id: newId(), role: "assistant", content: "", pending: true };
    let final = reply;
    let sent = filesRef.current.get(userMsg.id) ?? [];
    // Attachments stay in memory only, so after a reload (Retry, Go ahead, Edit) the picture above is
    // fetched again from the chat. Without it, or other files sent before, nothing is sent, so a price
    // already agreed can't change.
    let missing = "";
    if (!sent.length && userMsg.pictureAbove) {
      const url = typeof userMsg.pictureAbove === "string" ? userMsg.pictureAbove : pictureAbove(earlier);
      const picture = url ? await pictureAttachment(url, controller.signal) : null;
      if (!picture) missing = NO_PICTURE;
      else if (!controller.signal.aborted) filesRef.current.set(userMsg.id, (sent = [picture]));
    } else if (!sent.length && userMsg.attachmentName) missing = NO_FILES;
    if (missing || controller.signal.aborted) {
      const stopped = controller.signal.aborted;
      if (abortRef.current === controller) abortRef.current = null;
      runningRef.current = false;
      setBusy(false);
      // Like a request that failed or was stopped, this holds Next up until the user says so.
      if (queueNow.current.length) setQueuePaused(true);
      if (unsent) unsent(stopped, missing);
      else if (!stopped) setNotice(missing);
      return { ...reply, pending: false, ...(stopped ? { stopped: true } : { error: missing }) };
    }
    // A template's request always goes to its own engine, and one the companion lined up to Auto
    // (the tool picked in the composer was for something else); anything else to the one picked.
    const engine = userMsg.template?.engine ?? userMsg.build ?? (userMsg.queued || userMsg.auto ? "auto" : choice);

    // Only the most recent app's code is sent back, so edits build on it without resending every version.
    const lastAppId = [...earlier].reverse().find((m) => m.app)?.id;
    const previous = [...earlier].reverse().find((m) => m.role === "assistant" && m.engine)?.engine;
    const history: ChatTurn[] = [
      ...earlier
        .filter((m) => !m.error || m.content || m.app)
        .map((m) => ({
          role: m.role,
          content: turnText(m),
          app: m.id === lastAppId ? m.app?.html : undefined,
        })),
      { role: "user", content: turnText(userMsg), attachment: sent[0], more: sent.length > 1 ? sent.slice(1) : undefined },
    ];

    updateProject(projectId, (p) => ({ ...p, updated_at: Date.now(), messages: [...earlier, userMsg, reply] }));
    jobRef.current = { request: userMsg.content, startedAt: Date.now(), projectId };
    setRunningIn(projectId);
    let finished = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          engine,
          // Memory can be turned off in Settings > Capabilities (on this device).
          preferences: readSetting("memoryOff") === "1" ? "" : preferences,
          previous,
          // Read when sent, so a queued request uses the level picked by then.
          ...(isLevel(readSetting("level")) && { level: readSetting("level") }),
          model: userMsg.template?.model ?? (engine === "auto" ? undefined : models[engine]),
          template: userMsg.template?.name,
          confirmed: confirmed || skipsCostCheck(),
          projectId,
          ...(userMsg.voice && { voice: true }),
          ...(userMsg.build && { build: true }),
          // The server only needs to know it's the picture above, for the reason it shows.
          ...(userMsg.pictureAbove ? { pictureAbove: true } : {}),
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
          final = applyEvent(final, e);
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
      final = aborted
        ? { ...final, stopped: true }
        : { ...final, error: err instanceof Error ? err.message : "Something went wrong.", errorCode: (err as { code?: string }).code };
    } finally {
      updateMessage(projectId, reply.id, (m) => ({ ...m, pending: false, status: undefined }));
      refreshMe();
      abortRef.current = null;
      runningRef.current = false;
      jobRef.current = null;
      // A request that failed, was stopped or waits for its price to be confirmed holds Next up,
      // so nothing runs on top of it until the user says so.
      if (!finished && queueNow.current.length) setQueuePaused(true);
      notifyDone(userMsg.content, finished, startedAt);
      setRunningIn("");
      setBusy(false);
      if (!typingElsewhere(inputRef.current)) inputRef.current?.focus();
    }
    return { ...final, pending: false, status: undefined };
  }

  /** One turn of a voice conversation: sends what was said to the open chat, on Auto, and says the answer. */
  async function talk(text: string): Promise<VoiceAnswer> {
    const stillWorking = { say: "I'm still working on your last request. Ask me again when it's done.", confirm: false };
    if (busy || runningRef.current) return stillWorking;
    // Talking from Home starts a new chat, as typing does.
    const chat = await ensureChat();
    if (!chat?.messages) return { say: "Open a chat first, then talk to me again.", confirm: false };
    updateProject(chat.id, (p) => ({
      ...p,
      name: !p.messages?.length && p.name === "New project" ? text.slice(0, 40) || p.name : p.name,
    }));
    // "Make it darker" said right after a picture changes that picture, as when it's typed.
    const ask: UIMessage = { id: newId(), role: "user", content: text, auto: true, voice: true };
    const reply = await respond(chat, chat.messages, withPicture(ask, followUpPicture(chat.messages, text, "auto")));
    return reply ? voiceReply(reply) : stillWorking;
  }

  /** "Yes" to a costly request asked for by voice: runs it, like Go ahead. */
  async function confirmByVoice(): Promise<VoiceAnswer> {
    const reply = await retry(true);
    return reply ? voiceReply(reply) : { say: "There's nothing waiting to go ahead.", confirm: false };
  }

  /**
   * Runs each request the companion lined up, as soon as Flash is free, in the chat it was asked
   * about (even if another chat is open now). It never takes the composer's text or files.
   */
  useEffect(() => {
    if (busy || runningRef.current || queuePaused || !queue.length || queue[0].waiting) return;
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
    // A queued "make it darker" right after a picture changes that picture, as when it's typed.
    const ask: UIMessage = { id: newId(), role: "user", content: next.request, queued: true };
    // When nothing could be sent, the request goes back to the front of Next up, paused, to Resume later.
    respond(project, project.messages, withPicture(ask, followUpPicture(project.messages, next.request, "auto")), false, (stopped, why) => {
      setQueue([next, ...queueNow.current]);
      setQueuePaused(true);
      if (!stopped) setNotice(why);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queuePaused, queue, projects]);

  /**
   * Adds a request the companion lined up to Next up, for the chat Flash is working in (or the
   * open one). "waiting" requests only run once the user presses Run.
   */
  const queueRequest = useCallback(
    async (request: string, waiting = false) => {
      // On Home no chat is open yet, so the request starts a new one (createProject says if that fails).
      const projectId = jobRef.current?.projectId || activeId || (await createProject())?.id;
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
      const tabs = ["settings", "profile", "general", "memory", "account", "privacy", "billing", "plan", "usage", "capabilities", "preferences", "brand", "connectors", "apps"];
      if (tabs.includes(page)) setSettingsTab(settingsTabFor(page));
      else if (page === "credits") setShowCredits(true);
      else if (page === "invite") setShowInvite(true);
      else if (page === "creations") setShowCreations("all");
      else if (page === "websites") setShowApps(true);
      else if (page === "instructions") setShowInstructions(true);
      else if (page === "templates") setTemplates("");
      setSidebar(false);
    },
    [],
  );

  /**
   * Makes a picture again in another shape (the shape words are read by the image engine). It's a
   * new picture of the prompt, so it never goes with the picture above: an edit keeps the old shape.
   */
  function reshape(prompt: string, shape: Reshape) {
    const how = { tall: "tall vertical 9:16", square: "square 1:1", wide: "wide 16:9" }[shape];
    send(`Make a ${how} picture of this: ${prompt}`, false, true);
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
  // The search on Home also finds tools ("image") and ready-made prompts ("invoice").
  const query = projectQuery.trim().toLowerCase();
  const toolHits = query ? ENGINES.filter((e) => isLive(e) && ENGINE_LABELS[e].toLowerCase().includes(query)) : [];
  const promptHits = query ? TEMPLATES.filter((t) => t.name.toLowerCase().includes(query)) : [];
  // The one-tap buttons for attached photos (Copy the text, Remove background…).
  const photoActions = photoActionsFor(files.map((f) => f.mediaType), isLive);
  const pickedNow = picked && picked.projectId === active?.id ? picked : null;
  // What's typed reads as a change to the picture Flash just made, so the picture goes with it.
  const above = pictureAbove(active?.messages);
  const changingPicture = !files.length && !pickedNow && Boolean(followUpPicture(active?.messages, input, choice, keepPicture));
  // Flash builds on the most recent app in the chat.
  const lastAppId = active?.messages?.findLast((m) => m.app)?.id;
  const liveCount = ENGINES.filter(isLive).length;
  const allOff = status && !liveCount;

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
      <>
        <Landing onStart={setAuthMode} status={status} initialPricing={pricing} />
        <InstallPopup />
      </>
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

  // Home shows until the open chat has messages: on a fresh start, after Home or New chat, and while a first message is on its way.
  const isHome = !active || active.messages?.length === 0;
  // Next up, the message box and the voice panel. The voice panel always sits in the bottom bar, so
  // starting a conversation on Home and getting the first answer (which opens the chat) never restarts it.
  const queueList = queue.length > 0 && (
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
  );
  const voicePanel = voice && (
    <VoiceMode
      name={firstName(me.user)}
      language={me.user.language}
      woke={voice.woke}
      first={voice.first}
      busy={busy}
      ask={talk}
      confirm={confirmByVoice}
      onStop={stop}
      onClose={() => setVoice(null)}
    />
  );
  // The words of the message, shared by Home's one-line box and the chat's two-row one.
  const messageBox = (
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
        pickedNow
          ? "Say what to change about it…"
          : photoActions.length
          ? files.length > 1
            ? "Ask about these photos, or say how to combine them…"
            : "Ask about it, say what to change, or tap a button above…"
          : above && changesPictures(choice)
            ? "Say what to change in the picture, or ask anything…"
            : choice === "auto"
            ? isHome
              ? "Ask anything, create anything…"
              : "Ask Flash anything…"
            : `Ask ${ENGINE_LABELS[choice]}…`
      }
      className={`block max-h-48 min-h-[44px] w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-zinc-200 light:placeholder:text-zinc-500 ${isHome ? "min-w-0 flex-1 px-1.5 py-[11px] placeholder-shown:overflow-hidden placeholder-shown:whitespace-nowrap" : "px-2.5 pb-1 pt-2"}`}
      aria-label="Message"
    />
  );
  const form = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
      className={`glass-raised @container/composer relative z-10 transition focus-within:border-white/25 has-[[role=menu]]:z-40 ${isHome ? "rounded-[20px] p-1.5" : "rounded-[26px] p-2.5"}`}
    >
      {pickedNow && (
        <div className="mb-1 ml-2 mt-1 inline-flex max-w-full items-center gap-2 rounded-lg bg-primary/15 px-3 py-1 text-xs text-primary-soft">
          <span className="truncate">◎ Changing the {pickedNow.label}</span>
          <button type="button" onClick={() => setPicked(null)} aria-label="Don't change this part" className="text-primary-soft/70 hover:text-zinc-100">
            ✕
          </button>
        </div>
      )}
      {changingPicture && (
        <div className="mb-1 ml-2 mt-1 inline-flex max-w-full items-center gap-2 rounded-lg bg-primary/15 px-3 py-1 text-xs text-primary-soft">
          <span className="truncate">✏️ Changing the picture above</span>
          <button
            type="button"
            onClick={() => setKeepPicture(above)}
            aria-label="Don't change the picture above"
            title="Make a new picture instead"
            className="text-primary-soft/70 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>
      )}
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
      {isHome ? (
        // Home: one line, like a search box: the tool sparkle, the words, then add, talk and send.
        <div className="flex items-end gap-1">
          <ToolPicker
            compact
            choice={choice}
            setChoice={setChoice}
            isLive={isLive}
            models={me.models}
            model={choice === "auto" ? undefined : models[choice]}
            setModel={(engine, id) => setModels((all) => ({ ...all, [engine]: id }))}
          />
          {messageBox}
          {(choice === "auto" || LEVEL_ENGINES.includes(choice)) && <LevelPicker compact level={level} setLevel={setLevel} />}
          <PlusMenu plain onFiles={() => fileRef.current?.click()} onCamera={() => cameraRef.current?.click()} />
          <MicButton
            plain
            disabled={busy}
            onText={(text) => {
              setInput((v) => (v.trim() ? `${v.trimEnd()} ${text}` : text));
              inputRef.current?.focus();
            }}
            onRecording={(file) => attach(file)}
            onListening={setDictating}
          />
          <SendButton square busy={busy} onStop={stop} disabled={!input.trim() && !attachment} />
        </div>
      ) : (
        <>
          {messageBox}
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
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {(choice === "auto" || LEVEL_ENGINES.includes(choice)) && <LevelPicker level={level} setLevel={setLevel} />}
              <MicButton
                disabled={busy}
                onText={(text) => {
                  setInput((v) => (v.trim() ? `${v.trimEnd()} ${text}` : text));
                  inputRef.current?.focus();
                }}
                onRecording={(file) => attach(file)}
                onListening={setDictating}
              />
              <TalkButton onTalk={() => setVoice({ woke: false })} waking={wakeState === "listening"} />
              <SendButton busy={busy} onStop={stop} disabled={!input.trim() && !attachment} />
            </div>
          </div>
        </>
      )}
    </form>
  );
  // A page (Home, AI Chat) is marked as the current one; a panel that opens over it (Voice) as pressed.
  const navItem = (label: string, d: string, on: boolean, run: () => void, panel = false, muted = false) => (
    <button
      key={label}
      onClick={() => {
        run();
        setSidebar(false);
      }}
      aria-current={on && !panel ? "page" : undefined}
      aria-pressed={panel ? on : undefined}
      className={`flex h-12 w-full items-center gap-4 rounded-2xl px-4 text-left text-[16px] transition ${
        on && !panel
          ? "bg-nav-active font-semibold text-white"
          : on
            ? "bg-white/[0.06] font-semibold text-white"
            : muted
              ? "text-zinc-400 hover:bg-white/[0.05] hover:text-white"
              : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
      }`}
    >
      <Icon d={d} className="h-6 w-6 shrink-0" />
      {label}
    </button>
  );

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className={`${sidebar ? "flex" : "hidden"} fixed inset-0 z-[35] w-full flex-col overflow-y-auto bg-zinc-950 md:static md:m-3 md:mr-0 md:flex md:w-[256px] md:shrink-0 md:rounded-[26px] md:bg-transparent md:glass`}
      >
        <div className="flex items-start justify-between px-5 pb-1 pt-6">
          <button onClick={goHome} className="flex items-center gap-2 text-left" aria-label="Flash AI, home">
            <span className="-ml-1 [filter:drop-shadow(0_4px_10px_rgb(91_140_246/0.35))]">
              <BrandMark size={56} id="flash-side" ring={false} vivid />
            </span>
            <span>
              <span className="block whitespace-nowrap text-[28px] font-bold leading-none tracking-tight text-white">
                FLASH <span className="font-light">AI</span>
              </span>
              <span className="mt-1.5 block whitespace-nowrap text-[11.5px] text-zinc-400">One App. Infinite Possibilities.</span>
            </span>
          </button>
          <button className="mt-1 text-zinc-400 md:hidden" onClick={() => setSidebar(false)} aria-label="Close menu">
            ✕
          </button>
        </div>
        <nav aria-label="Flash" className="mt-7 space-y-1.5 px-3">
          {navItem("Home", ICONS.home, isHome, goHome)}
          {navItem("AI Chat", ICONS.chat, !isHome, openChats)}
          {navItem("Create", ICONS.create, false, () => setTemplates(""))}
          {navItem("Voice", ICONS.voice, Boolean(voice), () => setVoice({ woke: false }), true)}
          {navItem("Images", ICONS.images, false, () => setShowCreations("image"))}
          {navItem("Workspace", ICONS.workspace, false, () => setShowApps(true))}
        </nav>
        <div className="mx-5 my-4 border-t border-white/[0.07]" />
        <nav aria-label="Library and settings" className="space-y-1 px-3">
          {navItem("Library", ICONS.library, false, () => setShowCreations("all"), false, true)}
          {navItem("Brand Hub", ICONS.brand, false, () => setSettingsTab("brand"), false, true)}
          {navItem("Settings", ICONS.settings, false, () => setSettingsTab("general"), false, true)}
        </nav>
        {/* Home lists the chats itself, so on a computer its sidebar stays as calm as the menu above. */}
        {isHome && <div className="hidden md:block md:flex-1" />}
        <div className={`mt-4 flex items-center justify-between px-5 ${isHome ? "md:hidden" : ""}`}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Chats</p>
          <button
            onClick={() => {
              goHome();
              pickTool("auto");
            }}
            aria-label="New chat"
            title="New chat"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/[0.06] hover:text-white"
          >
            <Icon d={ICONS.plus} className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        {projects.length > 1 && (
          <div className={`mt-2 px-3 ${isHome ? "md:hidden" : ""}`}>
            <input
              ref={sideSearchRef}
              type="search"
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              placeholder="Search chats"
              aria-label="Search projects and chats"
              className="h-9 w-full rounded-xl border border-white/8 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-primary/70"
            />
          </div>
        )}
        <nav aria-label="Chats" className={`mt-1.5 shrink-0 space-y-0.5 px-3 md:min-h-[7.5rem] md:flex-1 md:shrink md:overflow-y-auto ${isHome ? "md:hidden" : ""}`}>
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
                className="px-1 text-zinc-500 hover:text-zinc-200 md:hidden md:group-focus-within:block md:group-hover:block"
                onClick={() => togglePin(p.id)}
                aria-label={p.pinned ? "Unpin project" : "Pin project"}
                title={p.pinned ? "Unpin" : "Pin to the top"}
              >
                {p.pinned ? "⊘" : "📌"}
              </button>
              <button
                className="px-1 text-zinc-500 hover:text-zinc-200 md:hidden md:group-focus-within:block md:group-hover:block"
                onClick={() => renameProject(p.id)}
                aria-label="Rename project"
              >
                ✎
              </button>
              <button
                className="px-2 text-zinc-500 hover:text-red-400 md:hidden md:group-focus-within:block md:group-hover:block"
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
        <div className="space-y-2 p-3">
          {!me.plan && (me.paymentsEnabled || me.testPurchases) && (
            <div className="relative overflow-hidden rounded-2xl border border-white/10 p-4">
              <div className="pointer-events-none absolute inset-0 bg-iris-wash" />
              <div className="relative">
                <p className="flex items-center gap-2 font-semibold text-white">
                  <span aria-hidden>👑</span> Upgrade to Pro
                </p>
                <p className="mt-0.5 text-[13px] text-zinc-400">More power. More possibilities.</p>
                <button
                  onClick={() => {
                    setShowCredits(true);
                    setSidebar(false);
                  }}
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition hover:brightness-110"
                >
                  Get Started <Icon d={ICONS.arrow} className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          <button
            onClick={() => setShowInvite(true)}
            className={`w-full rounded-lg px-2 py-1 text-left text-xs text-gold-soft transition hover:bg-white/[0.04] hover:text-gold ${isHome ? "md:hidden" : ""}`}
          >
            🎁 Invite friends, earn credits
          </button>
          {status && (
            <details className={`px-2 text-xs text-zinc-400 ${isHome ? "md:hidden" : ""}`}>
              <summary className="cursor-pointer select-none hover:text-zinc-200">
                {liveCount === ENGINES.length ? "✨ What Flash can do" : `✨ What Flash can do · ${ENGINES.length - liveCount} coming soon`}
              </summary>
              <div className="mt-2 grid max-h-36 grid-cols-2 gap-1 overflow-y-auto">
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
        </div>
      </aside>

      {/* Main */}
      <main
        // An open menu lifts the whole column above the Ask Flash bubble (Home's scroller is its own layer).
        className="@container/main relative flex min-w-0 flex-1 flex-col has-[[role=menu]]:z-40"
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
        <header className={`flex h-16 shrink-0 items-center gap-2 px-4 sm:gap-3 md:h-[76px] md:px-6 ${isHome ? "mx-auto w-full max-w-[1600px] lg:px-8 @min-[1100px]/main:h-[96px]" : ""}`}>
          <button
            className="-ml-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-300 hover:bg-white/[0.05] md:hidden"
            onClick={() => setSidebar(true)}
            aria-label="Open menu"
          >
            <Icon d="M4 7h16 M4 12h16 M4 17h16" />
          </button>
          {isHome ? (
            <>
              <button onClick={goHome} className="shrink-0 md:hidden" aria-label="Flash AI, home">
                <BrandMark size={32} id="flash-top" ring={false} />
              </button>
              <Greeting me={me} className="hidden shrink @min-[1100px]/main:block" />
              <div className="hidden min-w-0 flex-1 @min-[1100px]/main:block" />
              <div ref={searchBoxRef} className="relative hidden min-w-0 max-w-2xl flex-[3] md:block @min-[1100px]/main:min-w-[300px] @min-[1100px]/main:max-w-[560px] @min-[1100px]/main:flex-[5]">
                <Icon d={ICONS.search} className="pointer-events-none absolute left-4 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-zinc-400" />
                <input
                  ref={searchRef}
                  type="search"
                  value={projectQuery}
                  onChange={(e) => {
                    setProjectQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  placeholder="Search anything... chats, projects, prompts or tools"
                  aria-label="Search your chats, projects, prompts and tools"
                  className="glass h-12 w-full rounded-2xl pl-12 pr-4 text-[15px] text-zinc-100 shadow-none outline-none placeholder:text-zinc-400 focus:border-primary/50 @min-[700px]/main:pr-16 @min-[1100px]/main:h-[52px]"
                />
                <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-sans text-[11px] text-zinc-400 @min-[700px]/main:block">
                  {mac ? "⌘ K" : "Ctrl K"}
                </kbd>
                {searchOpen && (
                  <div className="absolute left-0 right-0 top-full z-40 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10">
                    {!projectQuery.trim() && sorted.length > 0 && (
                      <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">{searchOpen === "all" ? "All chats" : "Recent chats"}</p>
                    )}
                    {toolHits.length > 0 && <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">Tools</p>}
                    {toolHits.map((e) => (
                      <button
                        key={e}
                        onClick={() => {
                          setSearchOpen(false);
                          setProjectQuery("");
                          pickTool(e);
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                      >
                        <EngineIcon engine={e} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{ENGINE_LABELS[e]}</span>
                      </button>
                    ))}
                    {promptHits.length > 0 && <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">Prompts</p>}
                    {promptHits.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => {
                          setSearchOpen(false);
                          setProjectQuery("");
                          setTemplates(t.id);
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                      >
                        <Icon d={ICONS.template} className="h-4 w-4 shrink-0 text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      </button>
                    ))}
                    {(toolHits.length > 0 || promptHits.length > 0) && sorted.length > 0 && (
                      <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">Chats</p>
                    )}
                    {(searchOpen === "all" || projectQuery.trim() ? sorted : sorted.slice(0, 10)).map((p) => (
                      <button
                        key={p.id}
                        onClick={() => openFromSearch(p.id)}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                      >
                        <Icon d={ICONS.chat} className="h-4 w-4 shrink-0 text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <span className="shrink-0 text-xs text-zinc-500">{timeAgo(p.updated_at)}</span>
                      </button>
                    ))}
                    {inChats.length > 0 && (
                      <>
                        <p className="px-3 pb-1 pt-2 text-xs font-medium text-zinc-500">In your chats</p>
                        {inChats.map((h) => (
                          <button
                            key={h.id}
                            onClick={() => openFromSearch(h.id)}
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/[0.06]"
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
                    {!sorted.length && !inChats.length && !toolHits.length && !promptHits.length && (
                      <p className="px-3 py-2 text-sm text-zinc-500">{projectQuery.trim() ? "Nothing matches." : "Your chats will show here."}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 @min-[1100px]/main:hidden" />
            </>
          ) : (
            <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium text-zinc-100">{active?.name ?? "Flash AI"}</h1>
          )}
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
              aria-label="Share"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 15V3 M7 8l5-5 5 5 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>
              <span className="hidden sm:inline">Share</span>
            </button>
          )}
          <button
            onClick={() => setShowCredits(true)}
            // In a chat on a phone the chat's name needs the room, so the balance shows only when it runs low.
            className={`${isHome ? "inline-flex @min-[1100px]/main:hidden" : me.credits < 10 ? "inline-flex" : "hidden sm:inline-flex"} h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] transition ${
              me.credits < 10
                ? "border-spark/50 bg-spark/10 text-spark-soft hover:bg-spark/20"
                : "glass text-zinc-100 shadow-none hover:brightness-110"
            }`}
            title="Credits: see costs and top up"
          >
            <BoltIcon className="h-3.5 w-3.5 text-gold" /> {me.credits.toLocaleString()}
            <span className="hidden @min-[900px]/main:inline">credits</span>
          </button>
          {isHome && <Bell me={me} onSites={() => setShowApps(true)} onCredits={() => setShowCredits(true)} />}
          <AccountMenu
            me={me}
            placement="down"
            onSettings={() => setSettingsTab("general")}
            onHelp={() => setCompanion(true)}
            onPlan={() => setShowCredits(true)}
            onInvite={() => setShowInvite(true)}
            onSignOut={() => signOut()}
          />
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
            start={showCreations}
            onClose={() => setShowCreations("")}
            onUseImage={
              busy
                ? undefined
                : (url) => {
                    setShowCreations("");
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
          onProfileChanged={(profile) => setMe((m) => (m ? { ...m, user: { ...m.user, ...profile } } : m))}
          onOpenCredits={() => {
            setSettingsTab(null);
            setShowCredits(true);
          }}
          onOpenInvite={() => {
            setSettingsTab(null);
            setShowInvite(true);
          }}
          onSignOut={(everywhere) => {
            setSettingsTab(null);
            signOut(everywhere);
          }}
          onCompanionShown={(shown) => setHideCompanion(!shown)}
          onWakeWord={setWakeOn}
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

        <div className={`min-h-0 flex-1 overflow-y-auto ${isHome ? "[mask-image:linear-gradient(to_bottom,transparent,#000_16px)]" : ""}`}>
          {(notice || !me.verified || allOff) && (
            <div className={`mx-auto space-y-3 px-4 pt-2 ${isHome ? "max-w-[1600px] sm:px-6 lg:px-8" : "max-w-3xl"}`}>
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
            </div>
          )}
          {isHome ? (
            <Home
              me={me}
              composer={
                voice ? null : (
                  <MenusOpenDown.Provider value>
                    {queueList}
                    {form}
                  </MenusOpenDown.Provider>
                )
              }
              isLive={isLive}
              projects={projects}
              onTool={pickTool}
              onAttach={() => {
                setVoice(null);
                fileRef.current?.click();
              }}
              onTalk={() => setVoice({ woke: false })}
              onOpenChat={openProject}
              onViewChats={viewAllChats}
              onPin={togglePin}
              onRename={renameProject}
              onDelete={deleteProject}
              onApps={() => setShowApps(true)}
              onTemplates={() => setTemplates("")}
              onUsage={() => setSettingsTab("usage")}
              onPlans={() => setShowCredits(true)}
              paymentsOn={me.paymentsEnabled || me.testPurchases}
            />
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
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
                  onEditApp={m.app && !m.pending ? (html) => editAppCode(m.id, html) : undefined}
                  // Flash builds on the latest app, so fixes and picked parts are for that one.
                  onFixApp={m.app && !m.pending && !busy && m.id === lastAppId ? (request) => fixApp(m.app!.kind, request) : undefined}
                  onPickApp={m.app && !m.pending && m.id === lastAppId ? (part) => pickApp(m.app!.kind, part) : undefined}
                />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {(!isHome || voice) && (
          <div className="px-4 pb-4 pt-2">
            <div className="mx-auto max-w-3xl">
              {queueList}
              {voicePanel || form}
              {!voice && (
                <p className="mt-2 hidden text-center text-xs text-zinc-500 sm:block">
                  Enter to send · Shift + Enter for a new line · drop or paste files anywhere
                </p>
              )}
            </div>
          </div>
        )}
        {/* Outside the message box, so Add files works while the voice panel shows too. */}
        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={onFile} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      </main>

      {(!hideCompanion || companion) && (
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
      )}
    </div>
  );
}
