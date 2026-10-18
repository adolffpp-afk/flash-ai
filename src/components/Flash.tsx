"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Message, type Reshape } from "./Message";
import { AuthScreen } from "./AuthScreen";
import { Landing } from "./Landing";
import { VerifyBanner } from "./VerifyBanner";
import { CreditsDialog } from "./CreditsDialog";
import { InviteDialog } from "./InviteFriends";
import { InstallPopup, useInstall } from "./InstallApp";
import { ShareDialog } from "./ShareDialog";
import { DownloadChat } from "./DownloadChat";
import { ProjectInstructions } from "./ProjectInstructions";
import { Settings, SKIP_COST_CHECK, settingsTabFor, type SettingsTab } from "./Settings";
import { AccountMenu } from "./AccountMenu";
import { AccountChooser, AddOver, SwitchAnyway } from "./AccountChooser";
import { EmailLabel } from "./EmailLabel";
import { Automations } from "./Automations";
import { Creations } from "./Creations";
import { Companion } from "./Companion";
import { Templates } from "./Templates";
import { MyApps } from "./MyApps";
import { BuildPanel, useMedia } from "./BuildPanel";
import { draftShown, draftStore, startsWriting } from "@/lib/live-draft";
import { OFFICE_TYPES, officeKind, officeText } from "@/lib/office";
import { MAX_PDF_MB, pdfText } from "@/lib/pdf-text";
import { addAttachment } from "@/lib/attachments";
import { MAX_QUEUE, recentTurns, type CompanionContext } from "@/lib/companion";
import { TEMPLATES, type Template, type TemplateValues } from "@/lib/templates";
import { ENGINES, ENGINE_LABELS, PENDING_LIMIT_MS, type Attachment, type ChatTurn, type Engine, type StreamEvent } from "@/lib/types";
import { applyEvent } from "@/lib/apply-event";
import { api, authedFetch, newId, type AccountSummary, type Me, type Pricing, type ProjectSummary, type UIMessage } from "@/lib/store";
import { PRODUCT_NAME } from "@/lib/product";
import { adoptAccountFromUrl, announce, forgetLink, getPin, getPinEmail, isolate, isTabAccount, linkedAccount, linkTarget, onAnnounce, reloadAs, setPin, setPinEmail, signedOutSince, signOutMark, signOutTab, takeLeftNote, type LeftNote } from "@/lib/account-pin";
import { forgetTones } from "@/lib/account-tones";
import { stopMic } from "@/lib/listen";
import { isLocalPath } from "@/lib/local-path";
import { forgetInvite, keepInviteInTab, leaveInviteToSignIn, saveInvite, signedInElsewhere, waitingInvite } from "@/lib/invite-keep";
import { saveTracker } from "@/lib/save-tracker";
import { hasCodeDraft } from "@/lib/code-drafts";
import { hasUnsent } from "@/lib/unsent";
import { PROJECT_TOO_LARGE } from "@/lib/project-size";
import type { ChatHit } from "@/lib/server/search";
import { BoltIcon, BrandMark, Wordmark } from "@/app/brand";
import { Home, ICONS, Icon } from "./Home";
import { Bell } from "./Bell";
import { ConnectorsButton, LevelPicker, MenusOpenDown, MicButton, PlusMenu, SendButton, TalkButton, ToolPicker, type Choice } from "./ComposerTools";
import { ConnectorTile } from "./YourConnectors";
import { PRESETS, accountReplies, type ActionCard, type ConnectionView } from "@/lib/connectors";
import { readChatConnectors, writeChatConnectors } from "@/lib/chat-connectors";
import { VoiceMode, type VoiceAnswer } from "./VoiceMode";
import { useWakeWord } from "./useWakeWord";
import { voiceReply, type VoiceMessage } from "@/lib/voice-chat";
import { priceWaiting } from "@/lib/price-question";
import { photoActionsFor } from "@/lib/photo-actions";
import { featureReady, findFeatures, isInstall, type FeatureAction, type FeatureSetup } from "@/lib/features";
import { pickedContext, type PickedElement } from "@/lib/preview-bridge";
import { pictureFollowUp } from "@/lib/router";
import { firstName } from "@/lib/names";
import { timeAgo } from "@/lib/when";
import { applyAppearance, applyTheme, notifiesWhenDone, readSetting, writeSetting } from "@/lib/device-settings";
import { LEVEL_ENGINES, isLevel, type Level } from "@/lib/levels";
import { showLanguage, tNow, useT } from "@/lib/use-t";
import { msg, type Translate } from "@/lib/i18n";
import { inAndroidApp } from "@/lib/android-shell";

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

/** The device's time zone ("Africa/Lagos"), so answers use the user's own date and time; "" when the browser can't say. */
const deviceTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.md,.csv,.txt,.json," +
  "audio/*,video/mp4,video/webm,video/quicktime,.docx,.xlsx,.pptx," +
  Object.keys(OFFICE_TYPES).join(",");
const MAX_FILE_MB = 3;
// Word, Excel and PowerPoint files are read in the browser and only their text is sent.
const MAX_OFFICE_MB = 20;
// The page's saves under way (its chats, their pins and names, the preferences), which a switch waits for.
const saving = saveTracker();

/**
 * Why the account chooser shows: a link for an account that isn't signed in here, this tab's
 * account logged out here (email and name: which, when known), or a switch to an account that
 * turned out not to be signed in here anymore.
 */
type Chooser = { reason: "link" | "gone" | "notHere"; email?: string; name?: string; accounts: AccountSummary[] };
/**
 * Add mode: signing in to another account over the page, then going to next (a page of Flash's).
 * back: the chooser that opened it, which Back returns to; again: the email of the account this tab
 * showed, to sign in to again; opened: which time add mode opened, so a sign-in that ends after its
 * add mode was closed (Back) doesn't go on.
 */
type Adding = { next?: string; error?: string; back?: Chooser; again?: string; opened?: number };
export type Status = Record<Engine, boolean>;

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
async function readOffice(file: File, kind: "docx" | "xlsx" | "pptx", t: Translate): Promise<Attachment | string> {
  if (file.size > MAX_OFFICE_MB * 1024 * 1024) return t("Word, Excel and PowerPoint files must be {size} MB or smaller.", { size: MAX_OFFICE_MB });
  try {
    const text = await officeText(new Uint8Array(await file.arrayBuffer()), kind, inflateRaw);
    return { name: file.name, mediaType: "text/plain", data: toBase64(text) };
  } catch {
    return t("Couldn't read the text in {name}. If it's an older .doc, .xls or .ppt file, save it as .docx, .xlsx or .pptx first.", { name: file.name });
  }
}

/** A big PDF as a text attachment, read in the browser, or an error to show. */
async function readPdf(file: File, t: Translate): Promise<Attachment | string> {
  if (file.size > MAX_PDF_MB * 1024 * 1024) return t("PDFs must be {size} MB or smaller.", { size: MAX_PDF_MB });
  try {
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    }
    const text = await pdfText(new Uint8Array(await file.arrayBuffer()), pdfjs);
    return { name: file.name, mediaType: "text/plain", data: toBase64(text) };
  } catch (e) {
    return e instanceof Error && e.message === "no text found"
      ? t("{name} looks like scanned pages with no text to read. Attach a smaller copy (under {size} MB) or photos of the pages instead.", {
          name: file.name,
          size: MAX_FILE_MB,
        })
      : t("Couldn't read {name}. Try saving it again as a PDF and attaching that.", { name: file.name });
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

/** A request going with the picture above, when there is one to go with. Saved in English, translated where it's shown. */
const withPicture = (m: UIMessage, url: string | null): UIMessage =>
  url ? { ...m, attachmentName: msg("The picture above"), pictureAbove: url } : m;

// Nothing is sent without the files a request goes with: the words alone would make something else.
const NO_PICTURE = msg("Couldn't open the picture above, so nothing was sent and no credits were used. Try again in a moment.");
const NO_FILES = msg("Attached files aren't kept once Flash is reloaded, so nothing was sent. Attach them again and send your message.");
// A reply the server finishes and saves on its own: the page lost its connection, or the chat was opened while it ran.
const STILL_WORKING = msg("Flash is still finishing this on the server. You can leave this page and come back.");
// Stop pressed: the server stops the reply (a picture, video or sound already being made is finished
// and delivered), then sends what it saved and charged.
const STOPPING = msg("Stopping…");
// How long Stop waits for the server to end the reply before leaving it to the server (see the watch).
const STOP_WAIT_MS = 10_000;

/** The picture above, ready to send with a follow-up, scaled down the way an attached photo is. */
async function pictureAttachment(url: string, signal?: AbortSignal): Promise<Attachment | null> {
  try {
    const res = await authedFetch(url, { signal });
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
  const t = useT();
  const [signedOut, setSignedOut] = useState(!signedIn);
  const [loadError, setLoadError] = useState(false);
  // Signed-out visitors see the landing page until they choose to sign up or sign in.
  const [authMode, setAuthMode] = useState<"signup" | "login" | null>(null);
  const [authError, setAuthError] = useState("");
  const [showCredits, setShowCredits] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [notice, setNotice] = useState("");
  // Several accounts in one browser (see account-pin.ts): the account a switch is under way to; the
  // chooser shown when this tab's account was logged out here, or a link was for another account;
  // a switch waiting on "Switch anyway" (go: what it does then; added: after Add another account,
  // whose account is signed in here already); add mode (signing in to another account); a log out
  // under way; and an invitation for another account signed in here.
  const [switching, setSwitching] = useState<string | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [unsaved, setUnsaved] = useState<{ go: () => void; added?: boolean; writing?: boolean } | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  // Which log out is under way, from the profile menu or Settings: the menu and Settings say so.
  const leavingRef = useRef(false);
  const [loggingOut, setLoggingOut] = useState<"one" | "all" | null>(null);
  const [addNext, setAddNext] = useState<string | undefined>(undefined);
  const [inviteFor, setInviteFor] = useState<{ id: string; email: string } | null>(null);
  // This page opened because another tab signed in (the landing page's reload): until its account
  // loads, the browser's invitation is that tab's to join, not this one's.
  const elsewhereRef = useRef(false);
  // The account a link opened this tab as (?as=), until it is known to be signed in here.
  const linkedRef = useRef<string | null>(null);
  // "Logged out of …", said once the next account has loaded (see reloadAs).
  const leftRef = useRef<LeftNote | null>(null);
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
  // The file Flash is writing, for the live preview (see live-draft.ts). It's kept out of the chat's
  // state, so only the preview draws again as the file grows, and it's never saved.
  const [drafts] = useState(draftStore);
  // The preview beside the chat, hidden with its button until the next build; on a phone or a narrow
  // window, whether the chat or the preview shows.
  const [panelHidden, setPanelHidden] = useState(false);
  const [phoneTab, setPhoneTab] = useState<"chat" | "preview">("chat");
  // The chat whose preview was last opened on a phone, so a reply there that doesn't build brings the chat back.
  const previewIn = useRef("");
  // The reply Flash has started writing a file in (see startsWriting): only from then on does the
  // preview show it being built, so a reply from the builder that is only words never opens or dims it.
  const [writing, setWriting] = useState("");
  // Wide enough for the preview beside the chat, and for it and the open companion both.
  const wide = useMedia("(min-width: 1280px)");
  const roomy = useMedia("(min-width: 1760px)");
  // Installing Flash from "Everything Flash can do" or the search; nothing to install inside the installed app.
  const install = useInstall();
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
  // The user's connected accounts (Settings > Connectors), once connectors are set up on this server,
  // and which are on in each chat ("" for the chat a message from Home starts), kept on this device.
  const [accounts, setAccounts] = useState<ConnectionView[]>([]);
  const [connectorChoice, setConnectorChoice] = useState<Record<string, string[]>>({});
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
  // The chat a request is running in right now, which may not be the open one, and the id of its reply.
  const [runningIn, setRunningIn] = useState("");
  const [runningReply, setRunningReply] = useState("");
  // What the running request was asked to do, where, and when it started, for the companion.
  const jobRef = useRef<{ request: string; startedAt: number; projectId: string } | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [dragging, setDragging] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Where the message box is, for the companion's closed button (see Companion).
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
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
  const [showAutomations, setShowAutomations] = useState(false);
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
  // When a reply the server was finishing was first found missing from its chat (see the watch below).
  const missedRef = useRef(new Map<string, number>());
  // Replies whose request got no answer at all (Stop before it, or the connection lost), so it may
  // never have reached the server, and whether Stop was pressed: until the server's copy of the chat
  // has them, the watch gives up on them after a minute (see below).
  const unsureRef = useRef(new Map<string, boolean>());
  // The request running now was answered (the server has it), and Stop was pressed for it.
  const acceptedRef = useRef(false);
  const stoppingRef = useRef(false);
  const prefsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Preferences typed but not sent yet (sent 600 ms after the last change).
  const prefsPending = useRef<string | null>(null);
  // What the account check and saving before a switch read, as of the last render.
  const meRef = useRef<Me | null>(null);
  const chooserRef = useRef<Chooser | null>(null);
  const addingRef = useRef<Adding | null>(null);
  const addSeq = useRef(0);
  const projectsRef = useRef<Project[]>([]);
  useEffect(() => {
    meRef.current = me;
  }, [me]);
  useEffect(() => {
    chooserRef.current = chooser;
  }, [chooser]);
  useEffect(() => {
    addingRef.current = adding;
  }, [adding]);
  const inviteForRef = useRef<{ id: string; email: string } | null>(null);
  useEffect(() => {
    inviteForRef.current = inviteFor;
  }, [inviteFor]);
  // Signed out, on the landing page (not in its sign-in form): the account check opens an account
  // signed in on this browser again meanwhile (in another tab), as a reload would.
  const landingRef = useRef(false);
  useEffect(() => {
    landingRef.current = signedOut && !authMode;
  }, [signedOut, authMode]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  // A message being written (its words, its files, the part of the app picked for it), which going
  // on as another account drops: Flash asks first (see leaveCheck), as for an Edit of a message and
  // a question for Ask Flash (hasUnsent).
  const writingRef = useRef(false);
  useEffect(() => {
    writingRef.current = Boolean(input.trim() || files.length || (picked && picked.projectId === activeId));
  }, [input, files, picked, activeId]);

  /**
   * The only way the account's data reaches the page. mark: taken as it was asked for (see
   * signOutMark).
   */
  async function adoptMe(fetched: Me, mark: number): Promise<Me | null> {
    // An answer asked for before this tab moved to another account (a reply's refresh that ends
    // just as a switch reloads the tab) is left alone: it must not take the tab back to its account.
    // Nor is one asked for before this tab signed out (a reply's refresh that ends just as Log out
    // does): it must not name that account to whoever signs in next here.
    if (signedOutSince(mark) || !isTabAccount(fetched.account)) return null;
    // Play's billing rule: nothing is for sale inside the Android app (see android-shell.ts), whichever account.
    const data = inAndroidApp() ? { ...fetched, paymentsEnabled: false, testPurchases: false } : fetched;
    // This tab shows this account from now on (the default's, when it showed none), and remembers
    // its email to say which account it was if it is logged out before a reload.
    setPin(data.account);
    setPinEmail(data.user.email);
    // A link for this account opened its page, or opens it now: nothing waits on it after a reload.
    forgetLink();
    if (linkedRef.current === data.account) linkedRef.current = null;
    // Flash's own words switch to the account's language before its first screen shows.
    await showLanguage(data.user.language);
    if (signedOutSince(mark)) return null;
    setMe(data);
    setLoadError(false);
    return data;
  }

  async function refreshMe(): Promise<Me | null> {
    // Once this tab signs out, whatever comes back for the account it showed is for nobody here.
    const mark = signOutMark();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await adoptMe(await api<Me>("/api/me"), mark);
      } catch (err) {
        if (signedOutSince(mark)) return null;
        if ((err as { status?: number }).status !== 401) {
          setLoadError(true);
          return null;
        }
        const found = await checkAccounts();
        // The default when this tab had none (or a session that ended just then): tried once more.
        if (found !== "gone" && found !== "none" && attempt === 0 && !signedOutSince(mark)) continue;
        // "gone": the chooser asks which account to keep going with.
        if (found !== "gone") setSignedOut(true);
        return null;
      }
    }
    return null;
  }

  /**
   * After the server said this tab is signed out, or another tab changed the accounts: who is still
   * signed in here. "here" when this tab's account still is (the list in the menu is refreshed),
   * "back" when it is signed in here again while the chooser asked, or while signing in from it
   * (the chooser, or that sign-in, closes), "none" when nobody is, "retry" when this tab had no
   * account and now has the default, and "gone" when its account was logged out but others are
   * signed in: the chooser shows, and this tab never moves to another account on its own. While
   * add mode is open, the chooser never covers it: its Back leads to the chooser instead.
   */
  async function checkAccounts(): Promise<"here" | "back" | "none" | "retry" | "gone"> {
    const mark = signOutMark();
    let list: { default: string | null; accounts: AccountSummary[] };
    try {
      list = await api<{ default: string | null; accounts: AccountSummary[] }>("/api/auth/accounts");
    } catch {
      return "here";
    }
    // This tab signed out while it asked: who was signed in here then gives it no account now.
    if (signedOutSince(mark)) return "here";
    let mine = getPin();
    // A page's requests name the account it shows, whatever a reload that didn't happen left behind.
    const showing = meRef.current?.user;
    if (mine && showing && mine !== showing.id) {
      setPin(showing.id);
      setPinEmail(showing.email);
      mine = showing.id;
    }
    const signingIn = addingRef.current;
    if (mine && list.accounts.some((a) => a.id === mine)) {
      setMe((m) => (m ? { ...m, accounts: list.accounts } : m));
      recheckInvite(list.accounts);
      // Signed in here again (in another tab, or by an emailed link) while the chooser asked which
      // account to use, or while signing in from it: this tab goes on as it.
      if (signingIn?.back) {
        closeAdding();
        return "back";
      }
      if (!chooserRef.current) return "here";
      setChooser(null);
      return "back";
    }
    if (!list.accounts.length) {
      signOutTab();
      forgetTones();
      return "none";
    }
    if (!mine) {
      setPin(list.default);
      return "retry";
    }
    const loaded = meRef.current?.user.id === mine ? meRef.current.user : null;
    const gone: Chooser = { reason: linkedRef.current === mine ? "link" : "gone", email: loaded?.email ?? getPinEmail(), name: loaded?.name, accounts: list.accounts };
    // Signing in over the page (add mode): the form stays as it is, and its Back leads to the
    // chooser, with who is signed in here now.
    if (signingIn) {
      const next = { ...signingIn, back: signingIn.back ? { ...signingIn.back, accounts: list.accounts } : gone };
      addingRef.current = next;
      setAdding(next);
      return "gone";
    }
    showChooser(gone);
    return "gone";
  }

  /**
   * The account chooser, once this tab's account isn't signed in here: it is in charge. "Switch
   * anyway?" and the switch waiting on it are dropped, as nothing of a logged-out account can be
   * saved, so every choice in the chooser can be taken.
   */
  function showChooser(next: Chooser) {
    setUnsaved(null);
    setSwitching(null);
    // Nothing of that account listens on under it either, as under add mode.
    setVoice(null);
    stopMic();
    setChooser(next);
  }

  /**
   * The invitation offered to another account here, once that account isn't signed in here anymore:
   * the server is asked again, so what shows is its answer now, as after a reload, never a Switch
   * to an account that isn't here.
   */
  function recheckInvite(accounts: AccountSummary[]) {
    const invited = inviteForRef.current;
    if (!invited || accounts.some((a) => a.id === invited.id)) return;
    inviteForRef.current = null;
    setInviteFor(null);
    void acceptInvite();
  }

  /** Joins the team from a saved invitation link, once signed in. */
  async function acceptInvite() {
    // Opened because another tab signed in: that tab joins the browser's invitation, this one only its own.
    const token = waitingInvite(!elsewhereRef.current);
    elsewhereRef.current = false;
    if (!token) return;
    // Signed out while it was on its way: what the server said is for nobody here now.
    const mark = signOutMark();
    try {
      await api("/api/team/accept", { method: "POST", json: { token } });
      forgetInvite();
      if (signedOutSince(mark)) return;
      setNotice(t("You joined the team. Your requests now use the team's shared credits."));
      await refreshMe();
    } catch (err) {
      if (signedOutSince(mark)) return;
      const { code, data } = err as { code?: string; data?: { forAccount?: { id: string; email: string } } };
      // For another account signed in here: kept in this tab only, so other tabs and accounts don't
      // ask too, and joined once this tab switches to it (start runs again then), or put away.
      if (code === "other_account" && data?.forAccount) {
        keepInviteInTab(token);
        return setInviteFor(data.forAccount);
      }
      // An unconfirmed email can try again after confirming; any other answer is final.
      if (code !== "unverified") forgetInvite();
      setNotice(err instanceof Error ? err.message : t("Couldn't join the team."));
    }
  }

  async function start() {
    const mark = signOutMark();
    const data = await refreshMe();
    if (!data) return;
    // Put into words in this account's language, now shown (see reloadAs).
    const left = leftRef.current;
    leftRef.current = null;
    // Only on the account the note says this tab went on as (not after a reload that didn't happen then).
    if (left && left.next === data.user.email) setNotice(tNow("Logged out of {email}. You're now using {next}.", { email: isolate(left.email), next: isolate(left.next) }));
    setSignedOut(false);
    acceptInvite();
    setPreferences(data.user.preferences);
    try {
      // Flash opens on Home, which greets the user and lists their latest chats.
      const { projects: list } = await api<{ projects: ProjectSummary[] }>("/api/projects");
      // Logged out while the list was on its way: its chats are for nobody here, whoever signs in next.
      if (signedOutSince(mark)) return;
      setProjects(list);
      setActiveId("");
    } catch {
      if (signedOutSince(mark)) return;
      setMe(null);
      setLoadError(true);
    }
  }

  // The language picked in Settings. Signed out, the sign-in and sign-up screen follows the
  // browser's language (""), while the landing page stays in English, even right after a session ends.
  // So do the account chooser and add mode before any account has loaded here.
  const savedLanguage = signedOut && !authMode ? "en" : me ? (me.user.language ?? "") : signedOut || chooser || adding ? "" : "en";
  useEffect(() => {
    void showLanguage(savedLanguage);
  }, [savedLanguage]);

  // With several accounts here, the browser's tab says which one this tab is on; not once that one
  // isn't signed in here anymore (the chooser asks which account to use, or signing in from it does).
  const tabEmail = me && !chooser && !adding?.back && (me.accounts?.length ?? 0) > 1 ? me.user.email : null;
  useEffect(() => {
    if (!tabEmail) return;
    const before = document.title;
    document.title = `${tabEmail} · ${PRODUCT_NAME}`;
    return () => {
      document.title = before;
    };
  }, [tabEmail]);

  useEffect(() => {
    // A link that names its account (?as=, from an email, Stripe or a callback) opens as it.
    // After a reload of that tab, before the link's account loaded here, it is still the link's.
    const named = adoptAccountFromUrl();
    linkedRef.current = named ?? linkedAccount();
    // Signed in by such a link (Continue with Google, GitHub or Microsoft ends here, signed in by the
    // server): Flash's other tabs signed out here open the account too.
    if (named && signedIn) announce({ type: "changed" });
    // Reloaded because another tab signed in: the browser's invitation is that tab's to join.
    elsewhereRef.current = signedInElsewhere();
    const opened = new URLSearchParams(window.location.search);
    // Add another account (from the Connect to Flash page): then back to where it came from.
    const back = opened.get("next");
    const safeNext = isLocalPath(back) ? back : undefined;
    if (opened.get("add") === "1") {
      if (signedIn) openAdding({ next: safeNext });
      else {
        setAuthMode("login");
        setAddNext(safeNext);
      }
      window.history.replaceState(null, "", window.location.pathname);
    }
    // A note left for this tab before it reloaded as another account ("Logged out of …"), said
    // once that account has loaded, in its language.
    leftRef.current = takeLeftNote();
    // Loading the account must wait for the browser, so this runs once after mount. With no account
    // signed in here, whoever signs in alone next has Flash's own colour.
    if (signedIn) start();
    else forgetTones();
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
      saveInvite(invite);
      if (!signedIn) setNotice(t("Sign in or create an account with the invited email to join the team."));
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
          ? t("Thanks! Your credits were added.")
          : purchase === "subscribed"
            ? t("Welcome to your new plan! This month's credits are on their way.")
            : t("Checkout was cancelled. No charge was made."),
      );
      window.history.replaceState(null, "", window.location.pathname);
    }
    // A connected app (see /connector) links here to get more credits.
    if (params.get("credits") && signedIn) {
      setShowCredits(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
    // A connector's sign-in comes back here: Settings > Connectors says how it ended (and takes ?connect= out).
    if (params.get("connect") && signedIn) setSettingsTab("connectors");
    // A "Continue with …" sign-in that didn't finish comes back here to say why: while signed in,
    // that was adding another account, so the add screen says it.
    const authErr = params.get("auth_error");
    if (authErr) {
      setAuthError(authErr);
      setAuthMode("login");
      if (signedIn) openAdding({ error: authErr });
      window.history.replaceState(null, "", window.location.pathname);
    }
    const verified = params.get("verified");
    const reset = params.get("reset");
    // A confirmation link opened while not signed in to its account (see api/auth/verify).
    if (verified === "signin") {
      setAuthError("verify_signin");
      setAuthMode("login");
      if (signedIn) setNotice(t("To confirm your email, sign in to that account, then open the link in the email again."));
      window.history.replaceState(null, "", window.location.pathname);
    } else if (verified || reset) {
      setNotice(
        reset
          ? t("Your password was changed. You're signed in.")
          : verified === "1"
            ? t("Email confirmed. Your free credits were added.")
            : t("That confirmation link has expired or was already used. Send a new one from the banner."),
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

  // The user's connected accounts, for the Connectors button: read again whenever Settings closes.
  const connectorsOn = Boolean(me?.connectorsEnabled);
  useEffect(() => {
    if (!connectorsOn || settingsTab) return;
    // Logged out while they were on their way: they are for nobody here, whoever signs in next.
    const mark = signOutMark();
    api<{ ready: boolean; connections: ConnectionView[] }>("/api/connect")
      // A server still waiting to be added (its tools not looked at yet) isn't one a chat can use.
      .then((r) => signedOutSince(mark) || setAccounts(r.ready ? r.connections.filter((c) => c.status !== "review") : []))
      .catch(() => {});
  }, [connectorsOn, settingsTab]);

  // The accounts on in the open chat, as this device kept them.
  useEffect(() => {
    if (activeId && !(activeId in connectorChoice)) setConnectorChoice((c) => ({ ...c, [activeId]: readChatConnectors(activeId) }));
  }, [activeId, connectorChoice]);

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

  // "Hey Flash" listens while Flash is open, except while the mic button or a conversation is listening,
  // and never under the account chooser or add mode.
  const wakeState = useWakeWord(wakeOn && !voice && !dictating && Boolean(me) && !signedOut && !adding && !chooser, (rest) =>
    setVoice({ woke: true, first: rest }),
  );

  /** Sends the chats changed here, each save counted while it's under way (saving). */
  function saveChanged(): void {
    for (const id of dirtyRef.current) {
      const p = projectsRef.current.find((x) => x.id === id);
      // A reply that may never have reached the server waits until the watch knows, so it isn't
      // saved as one the server is working on.
      if (p?.messages?.some((m) => m.pending && unsureRef.current.has(m.id))) continue;
      dirtyRef.current.delete(id);
      if (!p?.messages) continue;
      // A reply the server is still finishing is sent as pending: the server keeps its own copy of
      // it (see keepRunning in turns.ts), and saves everything else as it is here.
      const messages = p.messages.map((m) => ({ ...m, pending: m.pending || undefined, status: undefined }));
      void saving.track(
        api(`/api/projects/${id}`, { method: "PUT", json: { name: p.name, messages } }).then(
          () => true,
          (err) => {
            // Saved by the server at the same moment: tried again with the next change.
            if (err?.status === 409) {
              dirtyRef.current.add(id);
              return false;
            }
            // Over 4.5 MB, Vercel refuses the save before Flash can say why.
            setNotice(err?.status === 413 ? tNow(PROJECT_TOO_LARGE) : err instanceof Error ? err.message : tNow("Couldn't save your project."));
            return false;
          },
        ),
      );
    }
  }

  /**
   * Saves everything changed here now, before this tab leaves its account (a switch or a log out):
   * the chats and the preferences still waiting, and the saves already under way, which the reload
   * would cancel. True when all of it was kept within 3 seconds; false when something didn't save,
   * or can't yet (a reply that may never have reached the server, code not saved in a Code view).
   */
  async function flushSaves(): Promise<boolean> {
    saveChanged();
    if (prefsPending.current !== null) {
      clearTimeout(prefsTimer.current);
      const value = prefsPending.current;
      prefsPending.current = null;
      void saving.track(api("/api/me", { method: "PATCH", json: { preferences: value } }).then(() => true, () => false));
    }
    const kept = await saving.settled(3000);
    return kept && dirtyRef.current.size === 0 && !hasCodeDraft();
  }

  /**
   * Before this tab goes on as another account (a switch, Add another account): what Flash asks
   * about first. "saves" when flushSaves couldn't keep everything, "writing" when all of it is
   * saved but a message is being written (in the message box, an Edit of a message or Ask Flash),
   * which isn't kept; null when nothing is lost by going.
   */
  async function leaveCheck(): Promise<"saves" | "writing" | null> {
    if (!(await flushSaves())) return "saves";
    return writingRef.current || hasUnsent() ? "writing" : null;
  }

  // Saves changed projects shortly after a reply finishes.
  useEffect(() => {
    if (busy || !dirtyRef.current.size) return;
    const timer = setTimeout(() => void saveChanged(), 600);
    return () => clearTimeout(timer);
  }, [projects, busy]);

  // Replies Flash is finishing on the server, not on this page: its connection was lost, Stop let a
  // picture finish, or the chat was opened while one ran. Their chats are fetched again every few
  // seconds while Flash is on screen, and at once when it's back in view or online, until each reply
  // is saved finished. The request itself is never sent again.
  const waiting = projects
    .flatMap((p) => (p.messages ?? []).filter((m) => m.pending && m.id !== runningReply).map((m) => `${p.id}/${m.id}/${m.pendingSince ?? 0}`))
    .join(" ");
  useEffect(() => {
    if (!waiting) return;
    const replies = waiting.split(" ").map((key) => key.split("/"));
    let checking = false;
    const check = async () => {
      if (checking || document.hidden) return;
      checking = true;
      let finished = false;
      for (const chat of new Set(replies.map(([projectId]) => projectId))) {
        let saved: UIMessage[] = [];
        let gone = false;
        try {
          saved = (await api<{ project: Project }>(`/api/projects/${chat}`)).project.messages ?? [];
        } catch (err) {
          // A deleted chat has nothing left to wait for; anything else is tried again.
          if ((err as { status?: number }).status !== 404) continue;
          gone = true;
        }
        // Each reply that's done: the server's copy, or how it ended when the server never had it.
        const done = new Map<string, UIMessage | "stopped" | null>();
        for (const [projectId, id, since] of replies) {
          if (projectId !== chat) continue;
          const reply = saved.find((m) => m.id === id);
          const unsure = unsureRef.current.has(id);
          const stoppedHere = unsureRef.current.get(id) === true;
          // The server has it, so its request reached it.
          if (reply) unsureRef.current.delete(id);
          if (reply?.pending) {
            missedRef.current.delete(id);
            continue;
          }
          // Missing from its chat. A request that got no answer may never have reached the server, so
          // it's given up a minute after it was first missed. One the server took is waited for as long
          // as it can run: it puts its answer back even when another tab's copy was saved over it.
          if (!reply && !gone) {
            const first = missedRef.current.get(id) ?? Date.now();
            missedRef.current.set(id, first);
            if (Date.now() < (unsure ? first + 60_000 : (Number(since) || first) + PENDING_LIMIT_MS)) continue;
          }
          missedRef.current.delete(id);
          unsureRef.current.delete(id);
          done.set(id, reply ?? (stoppedHere ? "stopped" : null));
        }
        if (!done.size) continue;
        finished = true;
        const unfinished = tNow("Flash couldn't finish this answer. Please try again.");
        const ended = (m: UIMessage): UIMessage => {
          const saved = done.get(m.id);
          if (saved && saved !== "stopped") return saved;
          return { ...m, pending: false, status: undefined, ...(saved === "stopped" ? { stopped: true } : { error: unfinished }) };
        };
        setProjects((list) => list.map((p) => (p.id === chat && p.messages ? { ...p, messages: p.messages.map((m) => (done.has(m.id) ? ended(m) : m)) } : p)));
      }
      checking = false;
      // The credits it used are settled by now.
      if (finished) refreshMe();
    };
    const timer = setInterval(check, 4000);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // refreshMe only sets state, whichever render's copy runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  const active = projects.find((p) => p.id === activeId);
  // A chat is saved as "New project" until its first message names it; that name is shown translated.
  const projectName = (name: string) => (name === "New project" ? t("New project") : name);
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
    setPhoneTab("chat");
    if (projects.find((p) => p.id === id)?.messages) return;
    try {
      const { project } = await api<{ project: Project }>(`/api/projects/${id}`);
      // A reply still pending there is one the server is working on; the watch below shows it once it's done.
      const messages = project.messages?.map((m) => (m.pending ? { ...m, status: t(STILL_WORKING) } : m));
      setProjects((list) => list.map((p) => (p.id === id ? { ...p, messages: p.messages ?? messages, instructions: project.instructions ?? "" } : p)));
    } catch {
      setNotice(t("Couldn't open that project. Pick it again in the sidebar to try again."));
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

  /** The accounts on in a chat ("" for the chat a message from Home starts) that can still be used. */
  const connectorsIn = (projectId: string) =>
    (connectorChoice[projectId] ?? []).filter((id) => accounts.some((a) => a.id === id && a.status === "ok"));

  /** The name of a connected account the message names as a word of its own, when it isn't one of those on. */
  function offAccountNamed(message: string, on: string[]): string | null {
    if (!connectorsOn) return null;
    const words = message.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u);
    for (const a of accounts) {
      if (a.status !== "ok" || on.includes(a.id)) continue;
      const name = PRESETS.find((p) => p.id === a.provider)?.name ?? a.label;
      const parts = name.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (parts.length && words.some((_, i) => parts.every((part, j) => words[i + j] === part))) return name;
    }
    return null;
  }

  /** Turns accounts on or off in the open chat (or for the chat Home's next message starts). */
  function setConnectorsHere(ids: string[]) {
    setConnectorChoice((c) => ({ ...c, [activeId]: ids }));
    if (activeId) writeChatConnectors(activeId, ids);
  }

  /** A connector card on a reply was answered: its new state is saved with the chat. */
  function updateCard(messageId: string, card: ActionCard) {
    if (!active) return;
    updateMessage(active.id, messageId, (m) => ({ ...m, actions: m.actions?.map((a) => (a.id === card.id ? card : a)) }));
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
      setNotice(err instanceof Error ? err.message : tNow("Couldn't create a project."));
      return null;
    }
  }

  /** Back to Home; the next message starts a new chat. */
  function goHome() {
    setActiveId("");
    setSidebar(false);
    setPhoneTab("chat");
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
    // The Movie maker is only for its own button; any other way into Video makes a clip.
    if (next === "video") setModels((all) => (all.video === "movie" ? { ...all, video: undefined } : all));
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /** Puts the cursor back in the message box after a pick in one of its menus, so typing goes there. */
  const refocus = () => requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));

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
  async function makeTemplate(template: Template, values: TemplateValues, document?: string): Promise<boolean> {
    if (template.engine === "local" ? !document : busy || runningRef.current) return false;
    const empty = active?.messages && !active.messages.length && active.id !== runningIn ? active : null;
    const project = empty ?? (await createProject());
    if (!project) return false;
    setTemplates(null);
    const name = template.title(values, t).slice(0, 60);
    const ask: UIMessage = { id: newId(), role: "user", content: template.request(values) };
    if (template.engine === "local") {
      const made: UIMessage = {
        id: newId(),
        role: "assistant",
        content: document ?? "",
        engine: "docs",
        reason: t("Made from the {name} template. The totals are worked out exactly, and it's free.", { name: t(template.name) }),
        cost: 0,
        local: true,
      };
      updateProject(project.id, (p) => ({ ...p, name, updated_at: Date.now(), messages: [...(p.messages ?? []), { ...ask, local: true }, made] }));
      return true;
    }
    updateProject(project.id, (p) => ({ ...p, name }));
    // The server names the chat too (it saves the turn), so it's told the template's title.
    void respond({ ...project, name }, [], { ...ask, template: { engine: template.engine, name: template.name, model: template.model } });
    return true;
  }

  async function deleteProject(id: string) {
    if (!confirm(t("Delete this project and its history?"))) return;
    try {
      await api(`/api/projects/${id}`, { method: "DELETE" });
    } catch {
      setNotice(t("Couldn't delete that project. Please try again."));
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
    void saving.track(
      api(`/api/projects/${id}`, { method: "PUT", json: { pinned } }).then(
        () => true,
        () => {
          setProjects((list) => list.map((p) => (p.id === id ? { ...p, pinned: !pinned } : p)));
          setNotice(t("Couldn't pin that project. Please try again."));
          return false;
        },
      ),
    );
  }

  function renameProject(id: string) {
    const current = projects.find((p) => p.id === id);
    const name = prompt(t("Project name"), current?.name)?.trim();
    if (!name || !current) return;
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
    void saving.track(
      api(`/api/projects/${id}`, { method: "PUT", json: { name } }).then(
        () => true,
        () => {
          setProjects((list) => list.map((p) => (p.id === id ? { ...p, name: current.name } : p)));
          setNotice(t("Couldn't rename that project. Please try again."));
          return false;
        },
      ),
    );
  }

  function changePreferences(value: string) {
    setPreferences(value);
    clearTimeout(prefsTimer.current);
    prefsPending.current = value;
    prefsTimer.current = setTimeout(() => {
      prefsPending.current = null;
      void saving.track(api("/api/me", { method: "PATCH", json: { preferences: value } }).then(() => true, () => false));
    }, 600);
  }

  /**
   * Switch account: saves what changed here first (or asks), then makes that account the default
   * and reloads as it. A reply running now is left to the server, which finishes and saves it for
   * the account it was asked in (see keepRunning in turns.ts). gone: this tab's account was already
   * logged out, so there's nothing it could save. True once the tab is reloading as that account;
   * false when it stays (it asks first, or the switch failed and says why).
   */
  async function switchAccount(id: string, { gone = false, anyway = false } = {}): Promise<boolean> {
    if (switching && !anyway) return false;
    setSwitching(id);
    const ask = gone || anyway ? null : await leaveCheck();
    if (ask) {
      // Unless this tab's account was logged out meanwhile: then the chooser asks, and nothing else.
      if (chooserRef.current) setSwitching(null);
      else setUnsaved({ go: () => void switchAccount(id, { anyway: true }), writing: ask === "writing" });
      return false;
    }
    setUnsaved(null);
    abortRef.current?.abort();
    try {
      await api("/api/auth/switch", { method: "POST", json: { account: id } });
    } catch (err) {
      setSwitching(null);
      // Logged out here meanwhile (in another tab): choose again from who is left.
      if ((err as { code?: string }).code === "not_signed_in") await checkAccountsFor(id);
      else setNotice(err instanceof Error ? err.message : t("Something went wrong."));
      return false;
    }
    reloadAs(id);
    // Still here a few seconds on: the browser's "Leave site?" kept this page, on its own account.
    // Switching can be chosen again.
    window.setTimeout(() => setSwitching(null), 3000);
    return true;
  }

  /**
   * "Use another account" in the chooser: add mode, whose Back returns to the chooser. When a link
   * was for an account not signed in here, the link opens once signed in to it (/?apps=1, say).
   */
  function addFromChooser(from: Chooser) {
    const target = from.reason === "link" ? linkTarget() : null;
    setChooser(null);
    openAdding({ back: from, next: target && isLocalPath(target) ? target : undefined });
  }

  /** "Sign in again" in the chooser: signing in to the account this tab showed, which then goes on where it was. */
  function signInAgain(from: Chooser) {
    setChooser(null);
    openAdding({ back: from, again: from.email });
  }

  /**
   * Add mode, over the page, which stays as it was underneath and out of reach (see addScreen).
   * Nothing of the page listens on under it: a voice conversation ends and the mic stops, so
   * nothing said while signing in (a password read out, say) is heard, sent or typed.
   */
  function openAdding(next: Adding) {
    setVoice(null);
    stopMic();
    addingRef.current = { ...next, opened: ++addSeq.current };
    setAdding(addingRef.current);
  }

  function closeAdding() {
    addingRef.current = null;
    setAdding(null);
  }

  /** The add mode a sign-in started in is still open: not closed meanwhile (Back, Escape), nor opened again. */
  const stillAdding = (from: Adding) => addingRef.current?.opened === from.opened;

  /**
   * Signed in from add mode. To the account this tab showed (Sign in again): it goes on where it
   * was. To another: the tab goes on as it, like a switch: what changed here is saved first, or
   * Flash asks (not when this tab's account already ended), and the account is named only once its
   * page loads (reloadAs), so until then every request still names the account this tab shows.
   */
  async function addDone(from: Adding, result?: { account?: string }) {
    announce({ type: "changed" });
    const id = result?.account;
    // Back (or Escape) before the sign-in, or the saves before going on, ended: the tab stays as it
    // was, on its account, and the menu (or the chooser) lists who is signed in here now.
    const stayed = () => {
      if (stillAdding(from)) return false;
      window.dispatchEvent(new Event("flash:account-check"));
      return true;
    };
    if (stayed()) return;
    // The account this tab shows: signed in to again from the chooser, or added with the tab's own
    // email and password (as a password manager offers them). There is nothing to switch to, so the
    // tab goes on where it was, and an add of the account it is already using says so.
    if (id && id === getPin() && (from.again || !from.next)) {
      closeAdding();
      const shown = meRef.current?.user;
      if (shown) void refreshMe();
      else void start();
      if (shown && !from.again && !from.back) setNotice(tNow("You're already using {email} in this tab.", { email: isolate(shown.email) }));
      return;
    }
    if (!id) return window.location.reload();
    const ask = !meRef.current || from.back ? null : await leaveCheck();
    if (stayed()) return;
    if (ask) {
      // Asked over the page, which keeps its changes if the person stays (Cancel).
      closeAdding();
      setUnsaved({ go: () => goOnAs(id, from.next), added: true, writing: ask === "writing" });
      return;
    }
    goOnAs(id, from.next);
  }

  /**
   * Add mode leaving the page to finish signing in (two-step sign-in's code page, a "Continue with
   * …" sign-in): what changed here is saved first, or Flash asks, as before a switch (not when this
   * tab's account already ended). Back meanwhile, or Cancel, keeps the tab here as it was.
   */
  async function addLeave(from: Adding, go: () => void) {
    const ask = !meRef.current || from.back ? null : await leaveCheck();
    if (!stillAdding(from)) return;
    if (!ask) return go();
    closeAdding();
    setUnsaved({ go, writing: ask === "writing" });
  }

  /** After Add another account: to the page of Flash it was for (Home when none), as that account. */
  function goOnAs(id: string, to?: string) {
    // Another page of Flash's (Connect to Flash) shows the account just signed in to, now the default.
    if (to && new URL(to, window.location.href).pathname !== "/") return window.location.replace(to);
    reloadAs(id, undefined, to);
  }

  /** After a switch to an account that turned out not to be signed in here: the chooser, with who is. */
  async function checkAccountsFor(id: string) {
    try {
      const list = await api<{ accounts: AccountSummary[] }>("/api/auth/accounts");
      if (!list.accounts.length) return void signedOutHere();
      setMe((m) => (m ? { ...m, accounts: list.accounts } : m));
      if (chooser || !list.accounts.some((a) => a.id === getPin())) {
        showChooser({ reason: "notHere", accounts: list.accounts.filter((a) => a.id !== id) });
      } else {
        setNotice(t("That account isn't signed in on this browser anymore."));
        // The invitation's Switch, say: what the server says of it now takes its place.
        recheckInvite(list.accounts);
      }
    } catch {
      setNotice(t("That account isn't signed in on this browser anymore."));
    }
  }

  // everywhere: Settings already logged this account out of every device (after: who this browser uses now).
  // True once this tab leaves the account (it reloads as the next one, or is signed out); false
  // when it stays, and says why. One log out at a time: the menu says "Logging out…" meanwhile.
  async function signOut(everywhere = false, after: { id: string; email: string } | null = null): Promise<boolean> {
    if (leavingRef.current) return false;
    leavingRef.current = true;
    setLoggingOut("one");
    const leaving = me?.user.email ?? "";
    const mine = getPin();
    let next = after;
    if (!everywhere) {
      // This tab, and other tabs showing this account, save what they have before it goes.
      if (mine) announce({ type: "leaving", account: mine });
      await flushSaves().catch(() => false);
      try {
        next = (await api<{ next: { id: string; email: string } | null }>("/api/auth/logout", { method: "POST", json: {} })).next;
      } catch (err) {
        // Nothing was logged out: this tab's account isn't the one signed in here anymore, or it named none.
        if ((err as { code?: string }).code === "account_required") {
          leavingRef.current = false;
          setLoggingOut(null);
          setNotice(err instanceof Error ? err.message : t("Reload Flash, then log out again."));
          void checkAccounts();
          return false;
        }
      }
    }
    // Another account is still signed in here: Flash goes on as it, and says so.
    if (next) {
      reloadAs(next.id, { email: leaving, next: next.email });
      // Still here a few seconds on: the browser's "Leave site?" kept this page.
      window.setTimeout(() => {
        leavingRef.current = false;
        setLoggingOut(null);
      }, 3000);
      return true;
    }
    setPin(null);
    announce({ type: "changed" });
    signedOutHere();
    return true;
  }

  /** Log out of all accounts: every session this browser holds ends (other devices stay signed in). */
  async function signOutAll(): Promise<boolean> {
    if (leavingRef.current) return false;
    leavingRef.current = true;
    setLoggingOut("all");
    for (const a of me?.accounts ?? []) announce({ type: "leaving", account: a.id });
    await flushSaves().catch(() => false);
    await api("/api/auth/logout", { method: "POST", json: { all: true } }).catch(() => {});
    setPin(null);
    announce({ type: "changed" });
    signedOutHere();
    return true;
  }

  /** What this tab keeps of an account that's no longer signed in here: nothing. No account is, so no badge colour is kept either. */
  function signedOutHere() {
    forgetTones();
    // The tab shows no account now: a reload asks for none, so it never opens a chooser naming this
    // one, and an answer still on its way for it (a reply's refresh, its chats) is dropped.
    signOutTab();
    // Nothing of this account keeps running, or runs later for whoever signs in next.
    abortRef.current?.abort();
    jobRef.current = null;
    setQueue([]);
    setQueuePaused(false);
    setMe(null);
    setProjects([]);
    setActiveId("");
    filesRef.current.clear();
    // Nor does anything of it wait for whoever signs in next in this tab: a voice conversation, the
    // mic (what it was recording goes nowhere), a message being written with its files, the part
    // picked for it and the tool and model chosen, a question about a switch, or what Flash said.
    setVoice(null);
    stopMic(true);
    setInput("");
    setFiles([]);
    setPicked(null);
    setChoice("auto");
    setModels({});
    setKeepPicture(null);
    setUnsaved(null);
    setSwitching(null);
    setNotice("");
    // Nor its search (the words, and what it found inside the chats), its connected accounts and
    // those on in a chat, or a window it had open (Settings, Ask Flash, the menu on a phone).
    setProjectQuery("");
    setChatHits([]);
    setSearchOpen(false);
    setAccounts([]);
    setConnectorChoice({});
    setSettingsTab(null);
    setShowApps(false);
    setShowCreations("");
    setShowAutomations(false);
    setTemplates(null);
    setShowShare(false);
    setShowInstructions(false);
    setShowCredits(false);
    setShowInvite(false);
    setCompanion(false);
    setSidebar(false);
    setAuthMode(null);
    setChooser(null);
    closeAdding();
    setInviteFor(null);
    setSignedOut(true);
    leavingRef.current = false;
    setLoggingOut(null);
  }

  // Another tab logged an account out, switched or added one; or this tab comes back into view; or
  // the server said this tab is signed out: who is still signed in here (see checkAccounts).
  useEffect(() => {
    let last = 0;
    const check = (now = false) => {
      if (!now && Date.now() - last < 15_000) return;
      last = Date.now();
      // Signed out, on the landing page: once an account is signed in on this browser again (in
      // another tab), this tab reloads to open it, so nothing of the page before comes back. The
      // tab that signed in joins an invitation waiting in this browser; this one doesn't try too.
      if (landingRef.current) {
        void api<{ accounts: AccountSummary[] }>("/api/auth/accounts").then(
          (list) => {
            if (!list.accounts.length || !landingRef.current) return;
            landingRef.current = false;
            leaveInviteToSignIn();
            window.location.reload();
          },
          () => {},
        );
        return;
      }
      // Nothing loaded yet, nothing to check; the chooser shown before this tab's account loaded
      // checks too, and so does signing in from it.
      if (!meRef.current && !chooserRef.current && !addingRef.current?.back) return;
      void checkAccounts().then((found) => {
        if (found === "none") signedOutHere();
        // That chooser's account was signed in again elsewhere: it loads now.
        else if (found === "back" && !meRef.current) void start();
      });
    };
    const shown = () => {
      if (!document.hidden) check();
    };
    const asked = () => check(true);
    window.addEventListener("flash:account-check", asked);
    document.addEventListener("visibilitychange", shown);
    const stop = onAnnounce((message) => {
      // This tab's account is about to log out in another tab: what changed here is saved first.
      if (message.type === "leaving") {
        if (message.account === getPin()) void flushSaves();
      } else check(true);
    });
    return () => {
      window.removeEventListener("flash:account-check", asked);
      document.removeEventListener("visibilitychange", shown);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Back to the chat on a phone, where the part shows above the message box.
    setPhoneTab("chat");
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
    // Accounts turned on from Home go with the chat this message starts.
    const fromHome = active ? undefined : connectorsIn("");
    const chat = await ensureChat();
    if (!chat) return;
    if (fromHome?.length) {
      setConnectorChoice((c) => ({ ...c, [chat.id]: fromHome, "": [] }));
      writeChatConnectors(chat.id, fromHome);
    }
    if (!chat.messages) {
      setNotice(t("This project didn't load. Pick it again in the sidebar."));
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
    // A connected account the message names but that is off in this chat isn't used (nothing is on
    // until the user turns it on), so they hear why the reply can't see it.
    const off = offAccountNamed(content, fromHome ?? connectorsIn(chat.id));
    if (off) setNotice(t("{name} is connected, but it's off in this chat. Turn it on with the Connectors button by the message box.", { name: off }));
    await respond(
      chat,
      chat.messages,
      userMsg,
      false,
      (stopped) => {
        // The picture above couldn't be opened (or Stop was pressed while it loaded), so nothing was
        // sent: the words go back in the box and the user decides.
        setInput((typed) => (typed.trim() ? typed : text));
        if (!stopped) setNotice(t("Couldn't open the picture above. Tap ✕ to make a new picture instead."));
      },
      undefined,
      undefined,
      fromHome && { ids: fromHome },
    );
  }

  /** Approved cards on a reply that can still write the answer on: done, not yet used, and their account on here. */
  const continuable = (m: UIMessage, projectId: string) =>
    (m.actions ?? []).filter((a) => a.status === "done" && !a.continued && connectorsIn(projectId).includes(a.connectionId));

  /**
   * Continue on an action card: a new message asks Claude to write the answer on with what the
   * approved calls returned (the server puts them in as that account's tool results). Only on the
   * latest reply, and paid like any reply.
   */
  async function continueWith(messageId: string) {
    const messages = active?.messages;
    if (!active || !messages || busy || runningRef.current || messages.at(-1)?.id !== messageId) return;
    const cards = continuable(messages.at(-1)!, active.id);
    if (!cards.length) return;
    const ids = cards.map((a) => a.id);
    // Marked at once so it can't be sent twice; Retry sends the same results again if this fails.
    const earlier = messages.map((m) =>
      m.id === messageId ? { ...m, actions: m.actions?.map((a) => (ids.includes(a.id) ? { ...a, continued: true } : a)) } : m,
    );
    // The ids are kept on the message (and saved with the chat), so Retry and Go ahead send them again, after a reload too.
    const userMsg: UIMessage = { id: newId(), role: "user", content: t("Continue with what came back."), continues: ids };
    await respond(active, earlier, userMsg);
  }

  /**
   * Answers the last user message again, replacing the reply after it. Returns the new reply. Go ahead
   * or a spoken yes (confirmed) sends back what Flash decided and priced before asking, so the request
   * runs on that engine and model, and the price agreed is the price paid.
   */
  async function retry(confirmed = false): Promise<UIMessage | null> {
    const messages = active?.messages;
    if (!active || !messages || busy || runningRef.current) return null;
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    if (lastUser === -1) return null;
    // A yes only goes ahead with a price question still waiting, never with whatever was asked last.
    if (confirmed && !priceWaiting(messages)) return null;
    const decided = confirmed ? messages[lastUser + 1]?.decided : undefined;
    return respond(active, messages.slice(0, lastUser), messages[lastUser], confirmed, undefined, decided);
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
    // Typed words replace what was heard, so they're routed and answered as typed.
    let edited: UIMessage = { ...old, content: text, voice: undefined };
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

  /**
   * Leaving the page doesn't stop Flash any more (the server finishes and saves the reply), so Stop
   * tells the server itself. Once the server has the request, the reply goes on arriving until the
   * server has stopped it, saved it and charged for it, so this page shows exactly that copy and what
   * it cost. If the server can't be told, or doesn't end it soon (a picture, video or sound already
   * being made is finished), the reply is left to the server and shows here once it's saved.
   */
  function stop() {
    // The file being written is taken away at once: a stopped build keeps nothing of it.
    drafts.clear();
    const controller = abortRef.current;
    const tell = () => api("/api/chat/stop", { method: "POST", json: { replyId: runningReply }, keepalive: true });
    if (!runningReply || !acceptedRef.current) {
      // Not answered yet: reading stops now. If the request reached the server, it hears Stop as it starts.
      stoppingRef.current = true;
      if (runningReply) tell().catch(() => {});
      controller?.abort();
      return;
    }
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    if (runningIn) updateMessage(runningIn, runningReply, (m) => ({ ...m, status: tNow(STOPPING) }));
    tell().catch(() => {
      // The server never heard it, so it finishes the reply: shown here once it's saved.
      if (abortRef.current === controller) stoppingRef.current = false;
      controller?.abort();
    });
    setTimeout(() => controller?.abort(), STOP_WAIT_MS);
  }

  /** A notification when a long request ends while Flash is in the background (Settings > General). */
  function notifyDone(request: string, ok: boolean, startedAt: number) {
    if (!notifiesWhenDone() || !document.hidden || Date.now() - startedAt < 8000) return;
    try {
      const body = request.length > 90 ? `${request.slice(0, 90)}…` : request;
      new Notification(ok ? t("Flash is done") : t("Flash stopped"), { body: body || t("Your request"), icon: "/app-icon/192", tag: "flash-done" });
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
    // What Flash decided before asking for the price, sent back with Go ahead (see retry).
    decided?: UIMessage["decided"],
    // Sees the reply as it's written (a voice conversation starts saying it).
    progress?: (reply: UIMessage) => void,
    // The accounts on for this request when the chat is new (else the chat's own), and approved
    // connector results to continue the answer with (see continueWith).
    connect?: { ids?: string[]; actions?: string[] },
  ): Promise<UIMessage | null> {
    // One request at a time: Flash shows it's busy and Stop works from the first tap.
    if (runningRef.current) return null;
    runningRef.current = true;
    acceptedRef.current = false;
    stoppingRef.current = false;
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
      if (!picture) missing = t(NO_PICTURE);
      else if (!controller.signal.aborted) filesRef.current.set(userMsg.id, (sent = [picture]));
    } else if (!sent.length && userMsg.attachmentName) missing = t(NO_FILES);
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
    // The user's own accounts, only as they turned them on in this chat: never for a request the
    // companion lined up, which they didn't type here.
    const connectorIds = !connectorsOn || userMsg.queued ? [] : (connect?.ids ?? connectorsIn(projectId));
    const continues = connect?.actions ?? userMsg.continues ?? [];

    // Only the most recent app's code is sent back, so edits build on it without resending every version.
    const lastAppId = [...earlier].reverse().find((m) => m.app)?.id;
    // A spoken "thanks" after an app is answered in words but is still about the app, so the next
    // follow-up can change it.
    const lastReply = [...earlier].reverse().find((m) => m.role === "assistant" && m.engine);
    const previous = lastReply?.about ?? lastReply?.engine;
    // Replies that used a connected account are marked, so the chat never goes to the free lane.
    const fromAccounts = accountReplies(earlier);
    const history: ChatTurn[] = [
      ...earlier
        // A price Flash asked about stays, so "how much was it?" is answered with the real price.
        .filter((m) => !m.error || m.content || m.app || m.errorCode === "confirm_cost")
        .map((m) => ({
          role: m.role,
          content: m.errorCode === "confirm_cost" && !m.content ? (m.error ?? "") : turnText(m),
          app: m.id === lastAppId ? m.app?.html : undefined,
          usedConnector: fromAccounts.has(m.id) || undefined,
        })),
      { role: "user", content: turnText(userMsg), attachment: sent[0], more: sent.length > 1 ? sent.slice(1) : undefined },
    ];

    updateProject(projectId, (p) => ({ ...p, updated_at: Date.now(), messages: [...earlier, userMsg, reply] }));
    jobRef.current = { request: userMsg.content, startedAt: Date.now(), projectId };
    setRunningIn(projectId);
    setRunningReply(reply.id);
    let wrote = false;
    let finished = true;
    // An answer came back from the server, and it took the request: from then on it finishes and
    // saves the reply itself, whatever happens to this page.
    let responded = false;
    let accepted = false;
    // The reply is left to the server, and shows here once it's saved (see the watch above).
    let onServer = false;

    try {
      const res = await authedFetch("/api/chat", {
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
          ...(confirmed && decided && { decided }),
          projectId,
          ...(userMsg.voice && { voice: true }),
          ...(userMsg.build && { build: true }),
          // The server only needs to know it's the picture above, for the reason it shows.
          ...(userMsg.pictureAbove ? { pictureAbove: true } : {}),
          // The server saves the turn too, so the answer is kept if this page is closed (see turns.ts).
          replyId: reply.id,
          userMessage: userMsg,
          afterId: earlier.at(-1)?.id ?? null,
          // A new chat's name when it isn't its first message (a template's title).
          ...(!earlier.length && project.name !== "New project" && { name: project.name }),
          // The device's time zone, so answers use the user's own date and time.
          ...(deviceTimeZone() && { timeZone: deviceTimeZone() }),
          ...(connectorIds.length && { connectors: connectorIds }),
          // Sent even with the accounts off, so the server refuses it rather than answer without the results.
          ...(continues.length && { actions: continues }),
        }),
        signal: controller.signal,
      });
      responded = true;
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: t("Request failed ({status})", { status: res.status }) }));
        // Signed out: for a tab that names its account, authedFetch has Flash check who is still
        // signed in here (the chooser while others are, the landing page when nobody is).
        if (res.status === 401 && !getPin()) setSignedOut(true);
        throw Object.assign(new Error(err.error), { code: err.code as string | undefined, decided: err.decided as UIMessage["decided"] });
      }
      accepted = acceptedRef.current = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ended = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as StreamEvent;
          if (!wrote && !stoppingRef.current && startsWriting(e)) {
            wrote = true;
            setWriting(reply.id);
            // A new build shows the preview beside the chat again.
            setPanelHidden(false);
          }
          if (e.type === "draft") {
            // The file being written goes to the live preview only, never onto the reply, so it's never saved.
            if (!stoppingRef.current) drafts.apply(reply.id, e);
            continue;
          }
          if (e.type === "error" || e.type === "stopped") finished = false;
          if (e.type === "done") ended = true;
          // An answer that isn't a build shows in the chat, on a phone too: sent from under the preview, it'd go unseen.
          if (e.type === "route" && e.engine !== "app" && e.engine !== "slides" && previewIn.current === projectId) setPhoneTab("chat");
          final = applyEvent(final, e);
          updateMessage(projectId, reply.id, (m) => applyEvent(m, e));
          // The finished file replaces the draft in the same redraw.
          if (e.type === "app" || e.type === "stopped" || e.type === "done") drafts.clear(reply.id);
          // Once Stop is pressed, a voice conversation says nothing more of it.
          if (e.type === "text" && !stoppingRef.current) progress?.(final);
        }
      }
      // The reply stopped arriving before its last line: the connection was cut. Never shown, as the
      // reply is left to the server below.
      if (!ended) throw new Error("The reply stopped arriving.");
    } catch (err) {
      finished = false;
      // The server answered with an error (no credits, a price to agree to): nothing was run or saved.
      // Anything else is left to the server, which finishes, stops or never had the request, and the
      // reply shows here once that's known (see the watch above): the connection was lost, or Stop was
      // pressed and the server didn't end the reply soon (a picture, video or sound being finished).
      onServer = !(responded && !accepted);
      const stopping = stoppingRef.current;
      // A request with no answer at all may never have reached the server.
      if (onServer && !responded) unsureRef.current.set(reply.id, stopping);
      const status = stopping ? final.status || t(STOPPING) : t(STILL_WORKING);
      const outcome = (m: UIMessage): UIMessage =>
        onServer
          ? { ...m, status, pendingSince: startedAt }
          : {
              ...m,
              error: err instanceof Error ? err.message : t("Something went wrong."),
              errorCode: (err as { code?: string }).code,
              decided: (err as { decided?: UIMessage["decided"] }).decided,
            };
      updateMessage(projectId, reply.id, outcome);
      final = outcome(final);
    } finally {
      // However the reply ended (finished, failed, lost or left to the server), its draft goes.
      drafts.clear(reply.id);
      // A reply with no app (words, a question, an error) is read in the chat, not under the preview.
      if (!final.app && previewIn.current === projectId) setPhoneTab("chat");
      if (!onServer) updateMessage(projectId, reply.id, (m) => ({ ...m, pending: false, status: undefined }));
      refreshMe();
      abortRef.current = null;
      acceptedRef.current = false;
      runningRef.current = false;
      jobRef.current = null;
      // A request that failed, was stopped or waits for its price to be confirmed holds Next up,
      // so nothing runs on top of it until the user says so.
      if (!finished && queueNow.current.length) setQueuePaused(true);
      if (!onServer) notifyDone(userMsg.content, finished, startedAt);
      setRunningIn("");
      setRunningReply("");
      setBusy(false);
      if (!typingElsewhere(inputRef.current)) inputRef.current?.focus();
    }
    // A reply left to the server says so, as a voice conversation reads it.
    return { ...final, pending: false, status: undefined, ...(onServer && { error: final.status }) };
  }

  /** One turn of a voice conversation: sends what was said to the open chat, on Auto, and says the answer. */
  async function talk(text: string, early?: (partial: VoiceMessage) => void): Promise<VoiceAnswer> {
    const stillWorking = { say: t("I'm still working on your last request. Ask me again when it's done."), confirm: false };
    if (busy || runningRef.current) return stillWorking;
    // Talking from Home starts a new chat, as typing does.
    const chat = await ensureChat();
    if (!chat?.messages) return { say: t("Open a chat first, then talk to me again."), confirm: false };
    updateProject(chat.id, (p) => ({
      ...p,
      name: !p.messages?.length && p.name === "New project" ? text.slice(0, 40) || p.name : p.name,
    }));
    // "Make it darker" said right after a picture changes that picture, as when it's typed.
    const ask: UIMessage = { id: newId(), role: "user", content: text, auto: true, voice: true };
    const reply = await respond(chat, chat.messages, withPicture(ask, followUpPicture(chat.messages, text, "auto")), false, undefined, undefined, early);
    return reply ? spokenAnswer(chat.id, reply) : stillWorking;
  }

  /** What Flash says after a reply in a voice conversation, with the price question it asks, if any. */
  function spokenAnswer(chat: string, reply: UIMessage): VoiceAnswer {
    const answer = voiceReply(reply, t);
    return answer.confirm ? { ...answer, asked: { chat, reply: reply.id } } : answer;
  }

  /**
   * "Yes" to a costly request asked for by voice: runs it, like Go ahead. Only the price question
   * the conversation asked (asked), still waiting in the open chat, goes ahead: not one answered with
   * the button since, nor whatever was asked last in another chat.
   */
  async function confirmByVoice(asked?: VoiceAnswer["asked"]): Promise<VoiceAnswer> {
    const nothing = { say: t("There's nothing waiting to go ahead."), confirm: false };
    if (!asked || !active || active.id !== asked.chat || !priceWaiting(active.messages ?? [], asked.reply)) return nothing;
    const reply = await retry(true);
    return reply ? spokenAnswer(active.id, reply) : nothing;
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
      setNotice(t("\"{request}\" didn't run: its chat couldn't be found.", { request: next.request.slice(0, 60) }));
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
        setNotice(t("Next up is full at {count} requests. They run one after another, then you can add more.", { count: MAX_QUEUE }));
        return;
      }
      setQueue([...list, { id: newId(), request, projectId, waiting }]);
    },
    [activeId, t],
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
        // A chat that used a connected account isn't shown to the companion (see cleanContext).
        ...(accountReplies(chat?.messages ?? []).size ? { usedConnector: true } : { usedConnector: false, recent: recentTurns(chat?.messages ?? []) }),
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

  /** Opens a feature from Home's "Everything Flash can do" or the search in the top bar. */
  function openFeature(action: FeatureAction) {
    setSearchOpen(false);
    if ("tool" in action) return pickTool(action.tool);
    if ("href" in action) return window.location.assign(action.href);
    const page = action.open;
    switch (page) {
      case "attach":
        // Auto, so the file and the words pick the tool, not whatever was picked before.
        pickTool("auto");
        return fileRef.current?.click();
      case "build-from-picture":
        // A screenshot or sketch goes to the App Builder.
        pickTool("app");
        return fileRef.current?.click();
      case "talk":
        return setVoice({ woke: false });
      case "chats":
        return viewAllChats();
      case "movie":
        pickTool("video");
        return setModels((all) => ({ ...all, video: "movie" }));
      case "companion":
        return setCompanion(true);
      case "automations":
        return setShowAutomations(true);
      case "install":
        return install.install();
      case "template:social-pack":
        return setTemplates("social-pack");
      case "templates":
      case "websites":
      case "creations":
      case "brand":
      case "memory":
      case "general":
      case "credits":
      case "invite":
      case "connectors":
        return openCompanionPage(page);
      default: {
        // A new page in features.ts needs a case here.
        const missing: never = page;
        return missing;
      }
    }
  }

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
      const blob = await (await authedFetch(url)).blob();
      const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      // The picture replaces any files waiting, so the photo buttons apply to it.
      setFiles([]);
      await attach(new File([blob], `flash-picture.${ext}`, { type: blob.type || "image/png" }));
      setInput("");
    } catch {
      setNotice(t("Couldn't open that picture. Download it and attach it with the + button instead."));
    }
  }

  const closeSettings = useCallback(() => setSettingsTab(null), []);
  const closeTemplates = useCallback(() => setTemplates(null), []);

  /** Adds a read file to the ones waiting to be sent, or says why it can't be added. */
  function addFile(file: Attachment) {
    const added = addAttachment(filesNow.current, file, t);
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
      setNotice(t("{name} is an older Office file. Save it as .docx, .xlsx or .pptx first, then attach it.", { name: file.name }));
      return;
    }
    const office = officeKind(file.name, file.type);
    if (office) {
      const read = await readOffice(file, office, t);
      if (typeof read === "string") setNotice(read);
      else addFile(read);
      return;
    }
    // Small PDFs go whole, so Flash sees their pictures too; bigger ones send only their text.
    if ((file.type === "application/pdf" || /\.pdf$/i.test(file.name)) && file.size > MAX_FILE_MB * 1024 * 1024) {
      setNotice(t("Reading {name}…", { name: file.name }));
      const read = await readPdf(file, t);
      if (typeof read === "string") setNotice(read);
      else {
        setNotice("");
        addFile(read);
      }
      return;
    }
    file = await shrinkPhoto(file);
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      alert(t("Files must be {size} MB or smaller.", { size: MAX_FILE_MB }));
      return;
    }
    // Audio and video files go to Transcribe, so say so up front when it isn't available yet.
    if (/^(audio|video)\//.test(file.type) && status && !status.transcribe) {
      setNotice(t("Transcribing audio and video isn't available yet. It's coming soon."));
      return;
    }
    addFile(await readFile(file));
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const list = [...(e.target.files ?? [])];
    e.target.value = "";
    attachAll(list);
  }

  // Looks inside the chats too, a moment after typing stops. What comes back once the words have
  // changed (or were cleared, as the account signed out here) is for nobody, so it's left out.
  useEffect(() => {
    const q = projectQuery.trim();
    if (q.length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      api<{ results: ChatHit[] }>(`/api/projects/search?q=${encodeURIComponent(q)}`)
        .then(({ results }) => current && setChatHits(results))
        .catch(() => current && setChatHits([]));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [projectQuery]);

  const sorted = [...projects]
    .filter((p) => !projectQuery.trim() || p.name.toLowerCase().includes(projectQuery.trim().toLowerCase()))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated_at - a.updated_at);
  const inChats = projectQuery.trim().length >= 2 ? chatHits.filter((h) => h.snippet && !sorted.some((p) => p.id === h.id)) : [];
  // Engines whose AI provider isn't set up yet show as coming soon, and light up once /api/status says so.
  const isLive = (e: Engine) => !status || status[e];
  // The search on Home also finds what Flash can do ("remove background") and ready-made prompts ("invoice").
  const query = projectQuery.trim().toLowerCase();
  const setup: FeatureSetup = {
    isLive,
    modelLive: (id) => Boolean(me?.models.find((m) => m.id === id)?.live),
    payments: Boolean(me?.paymentsEnabled),
    domains: Boolean(me?.domainsEnabled),
    connectors: Boolean(me?.connectorsEnabled),
  };
  const toolHits = findFeatures(query, undefined, t)
    .filter((f) => (f.soon || featureReady(f, setup)) && (install.available || !isInstall(f)))
    .slice(0, 6);
  // A prompt is found by its name in English or in the language Flash is shown in.
  const promptHits = query ? TEMPLATES.filter((template) => [template.name, t(template.name)].some((n) => n.toLowerCase().includes(query))) : [];
  // The one-tap buttons for attached photos (Copy the text, Remove background…).
  const photoActions = photoActionsFor(files.map((f) => f.mediaType), isLive);
  const pickedNow = picked && picked.projectId === active?.id ? picked : null;
  // What's typed reads as a change to the picture Flash just made, so the picture goes with it.
  const above = pictureAbove(active?.messages);
  const changingPicture = !files.length && !pickedNow && Boolean(followUpPicture(active?.messages, input, choice, keepPicture));
  // Flash builds on the most recent app in the chat, which the live preview shows.
  const appIndex = active?.messages?.findLastIndex((m) => m.app) ?? -1;
  const appMsg = appIndex === -1 ? undefined : active?.messages?.[appIndex];
  const lastAppId = appMsg?.id;
  // The app or deck Flash is writing in the open chat right now, until its file arrives.
  const lastMsg = active?.messages?.at(-1);
  const building =
    lastMsg?.pending && !lastMsg.app && (lastMsg.engine === "app" || lastMsg.engine === "slides") && lastMsg.id === writing ? lastMsg : undefined;
  // Whether the preview shows the file being written in place of the latest app. Read as a yes or no,
  // so the chat draws again only when that changes, never for each draft.
  const drafting = useSyncExternalStore(
    drafts.subscribe,
    () =>
      Boolean(building) &&
      drafts.get().reply === building?.id &&
      draftShown(drafts.get().html, { changing: Boolean(appMsg?.app), kind: building?.engine === "slides" ? "slides" : "app" }),
    () => false,
  );
  const liveCount = ENGINES.filter(isLive).length;
  const allOff = status && !liveCount;

  /** What the chooser says happened, in the language shown now. */
  const chooserTitle = ({ reason, email }: Chooser) =>
    reason === "link"
      ? t("This link is for another Flash account. Sign in to it to open the link.")
      : reason === "gone" && email
        ? t("{email} isn't signed in on this browser anymore.", { email: isolate(email) })
        : t("That account isn't signed in on this browser anymore.");

  // This tab's account was logged out here before its data loaded: which account now.
  if (chooser && !me) {
    return (
      <AccountChooser
        title={chooserTitle(chooser)}
        accounts={chooser.accounts}
        switching={switching}
        onChoose={(id) => void switchAccount(id, { gone: true })}
        onAdd={() => addFromChooser(chooser)}
        again={chooser.reason === "gone" && chooser.email ? { email: chooser.email, name: chooser.name, onChoose: () => signInAgain(chooser) } : undefined}
      />
    );
  }
  // Signing in to another account as well as this one, or again to the one this tab showed (again).
  // Back returns to the chooser that opened it, to the Connect to Flash page it came from, or to the
  // account shown: over the page, which stays as it was underneath (its chat, preview and code).
  const addBack = (from: Adding) => {
    if (from.back) {
      closeAdding();
      setChooser(from.back);
    } else if (from.next) window.location.replace(from.next);
    else closeAdding();
  };
  const addScreen =
    adding && (me || adding.back) ? (
      <AuthScreen
        initialMode="login"
        initialError={adding.error}
        next={adding.next}
        adding={{
          email: adding.back ? undefined : me?.user.email,
          again: adding.again,
          onBack: () => addBack(adding),
          leave: (go) => addLeave(adding, go),
        }}
        onDone={(result) => addDone(adding, result)}
      />
    ) : null;
  if (addScreen && !me) return addScreen;
  if (signedOut) {
    return authMode ? (
      <AuthScreen
        key={authMode}
        initialMode={authMode}
        initialError={authError}
        next={addNext}
        onDone={(result) => {
          // Flash's other tabs signed out here open this account too.
          announce({ type: "changed" });
          // Signed in from the Connect to Flash page's "Sign in to another account": back there.
          if (addNext && result?.account) return goOnAs(result.account, addNext);
          if (result?.account) setPin(result.account);
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
        <p>{t("Flash couldn't load your account. Please try again in a moment.")}</p>
        <button
          onClick={() => {
            setLoadError(false);
            start();
          }}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-100 hover:bg-zinc-900"
        >
          {t("Try again")}
        </button>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-gold" aria-label={t("Loading")} />
      </div>
    );
  }

  // Home shows until the open chat has messages: on a fresh start, after Home or New chat, and while a first message is on its way.
  const isHome = !active || active.messages?.length === 0;
  // The live preview of the chat's latest app, and of the one being written: beside the chat on a wide
  // screen when the open companion leaves room for both, else under a Chat / Preview switch, which
  // shows the chat whenever there's nothing to preview.
  const showPanel = !isHome && Boolean(appMsg || building);
  const beside = showPanel && wide && (!companion || roomy);
  const tab = showPanel && !beside ? phoneTab : "chat";
  const panelShown = beside && !panelHidden;
  // The header's button labels show when the chat column has room: beside the preview it's narrower
  // than the window, so there it's measured itself.
  const headerWords = beside ? "hidden @min-[700px]/main:inline" : "hidden sm:inline";
  const showPhoneTab = (v: "chat" | "preview") => {
    if (v === "preview") previewIn.current = activeId;
    setPhoneTab(v);
  };
  const showPreview = () => (beside ? setPanelHidden(false) : showPhoneTab("preview"));
  // What Flash says (a notice, an invitation for another account here): above the chat, however far
  // it is scrolled, or above the preview while it shows instead of the chat (on a phone), so it's
  // never out of sight.
  const said = (notice || inviteFor) && (
    <>
      {notice && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-zinc-100"
        >
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button onClick={() => setNotice("")} aria-label={t("Dismiss")} className="text-primary-soft hover:text-white">
            ✕
          </button>
        </div>
      )}
      {inviteFor && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-zinc-100">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 basis-56 break-words">{t("This invitation is for {email}. Switch to that account to join.", { email: isolate(inviteFor.email) })}</span>
            <button
              onClick={() => void switchAccount(inviteFor.id)}
              disabled={Boolean(switching)}
              className="flex min-h-10 max-w-full items-center rounded-lg bg-brand px-3 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
            >
              {switching === inviteFor.id ? t("Switching…") : <EmailLabel text={msg("Switch to {email}")} email={inviteFor.email} />}
            </button>
          </div>
          {/* Not now: the invitation is put away (its email link still works later). */}
          <button
            onClick={() => {
              forgetInvite();
              setInviteFor(null);
            }}
            aria-label={t("Dismiss")}
            className="text-primary-soft hover:text-white"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
  const panel = showPanel && (
    <BuildPanel
      drafts={drafts}
      appMsg={appMsg}
      publishedEarlier={appMsg?.app && !appMsg.app.slug ? active?.messages?.slice(0, appIndex).findLast((x) => x.app?.slug)?.app?.slug : undefined}
      building={building}
      drafting={drafting}
      live={Boolean(building) && building?.id === runningReply}
      busy={busy}
      onPublished={setAppSlug}
      onEditCode={editAppCode}
      onFix={fixApp}
      onPick={pickApp}
      onPlans={me.paymentsEnabled || me.testPurchases ? () => setShowCredits(true) : undefined}
    />
  );
  // The connected accounts on in the open chat (or for the chat Home's next message starts).
  const connectorsHere = connectorsOn ? connectorsIn(activeId) : [];
  const connectorsButton = connectorsOn && (
    <ConnectorsButton accounts={accounts} on={connectorsHere} setOn={setConnectorsHere} onManage={() => setSettingsTab("connectors")} />
  );
  // Next up, the message box and the voice panel. The voice panel always sits in the bottom bar, so
  // starting a conversation on Home and getting the first answer (which opens the chat) never restarts it.
  const queueList = queue.length > 0 && (
    <div className="mb-2 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs font-medium text-zinc-400">
          {queuePaused
            ? queue.length === 1
              ? t("Next up · 1 request paused, because the last request didn't finish")
              : t("Next up · {count} requests paused, because the last request didn't finish", { count: queue.length.toLocaleString(t.locale) })
            : queue[0].waiting
              ? queue.length === 1
                ? t("Next up · 1 request waiting for your OK")
                : t("Next up · {count} requests waiting for your OK", { count: queue.length.toLocaleString(t.locale) })
              : busy
                ? queue.length === 1
                  ? t("Next up · 1 request waiting for this one to finish")
                  : t("Next up · {count} requests waiting for this one to finish", { count: queue.length.toLocaleString(t.locale) })
                : queue.length === 1
                  ? t("Next up · 1 request starting now")
                  : t("Next up · {count} requests starting now", { count: queue.length.toLocaleString(t.locale) })}
        </p>
        {queuePaused && (
          <button
            type="button"
            onClick={() => setQueuePaused(false)}
            aria-label={t("Resume Next up")}
            className="shrink-0 rounded-full bg-primary/20 px-2.5 py-0.5 text-xs text-primary-soft hover:bg-primary/30"
          >
            {/* Not "Resume": that's also the CV template's name, and other languages need two words. */}
            {t("Continue")}
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
                {elsewhere && <span className="text-xs text-zinc-500"> · {t("in {name}", { name: projectName(elsewhere) })}</span>}
              </span>
              {q.waiting && (
                <button
                  type="button"
                  onClick={() => setQueue(queueNow.current.map((x) => (x.id === q.id ? { ...x, waiting: false } : x)))}
                  aria-label={t('Run "{request}"', { request: q.request })}
                  className="shrink-0 rounded-full bg-primary/20 px-2 text-xs leading-5 text-primary-soft hover:bg-primary/30"
                >
                  {t("Run")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setQueue(queueNow.current.filter((x) => x.id !== q.id))}
                aria-label={t('Remove "{request}" from Next up', { request: q.request })}
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
      dir="auto"
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
          ? t("Say what to change about it…")
          : photoActions.length
          ? files.length > 1
            ? t("Ask about these photos, or say how to combine them…")
            : t("Ask about it, say what to change, or tap a button above…")
          : above && changesPictures(choice)
            ? t("Say what to change in the picture, or ask anything…")
            : choice === "auto"
            ? isHome
              ? t("Ask anything, create anything…")
              : t("Ask Flash anything…")
            : t("Ask {tool}…", { tool: t(ENGINE_LABELS[choice]) })
      }
      className={`block max-h-48 min-h-[44px] w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-zinc-200 light:placeholder:text-zinc-500 ${isHome ? "min-w-0 flex-1 px-1.5 py-[11px] placeholder-shown:overflow-hidden placeholder-shown:whitespace-nowrap" : "px-2.5 pb-1 pt-2"}`}
      aria-label={t("Message")}
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
          <span className="truncate">◎ {t("Changing the {part}", { part: pickedNow.label })}</span>
          <button type="button" onClick={() => setPicked(null)} aria-label={t("Don't change this part")} className="text-primary-soft/70 hover:text-zinc-100">
            ✕
          </button>
        </div>
      )}
      {changingPicture && (
        <div className="mb-1 ml-2 mt-1 inline-flex max-w-full items-center gap-2 rounded-lg bg-primary/15 px-3 py-1 text-xs text-primary-soft">
          <span className="truncate">✏️ {t("Changing the picture above")}</span>
          <button
            type="button"
            onClick={() => setKeepPicture(above)}
            aria-label={t("Don't change the picture above")}
            title={t("Make a new picture instead")}
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
                aria-label={t("Remove {name}", { name: f.name })}
                className="text-zinc-400 hover:text-zinc-100"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {connectorsHere.length > 0 && (
        <div className="mb-1 ms-2 mt-1 flex flex-wrap gap-1.5">
          {accounts
            .filter((a) => connectorsHere.includes(a.id))
            .map((a) => (
              <div key={a.id} className="inline-flex max-w-full items-center gap-2 rounded-lg bg-primary/15 py-1 pe-3 ps-1.5 text-xs text-primary-soft">
                <ConnectorTile provider={a.provider} name={a.label} small />
                <span className="truncate">{a.label}</span>
                <button
                  type="button"
                  onClick={() => setConnectorsHere(connectorsHere.filter((id) => id !== a.id))}
                  aria-label={t("Turn off {name} in this chat", { name: a.label })}
                  className="text-primary-soft/70 hover:text-zinc-100"
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
              {t(a.label)}
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
            setChoice={(next) => {
              setChoice(next);
              refocus();
            }}
            isLive={isLive}
            models={me.models}
            model={choice === "auto" ? undefined : models[choice]}
            setModel={(engine, id) => setModels((all) => ({ ...all, [engine]: id }))}
          />
          {messageBox}
          {(choice === "auto" || LEVEL_ENGINES.includes(choice)) && (
            <LevelPicker
              compact
              level={level}
              setLevel={(next) => {
                setLevel(next);
                refocus();
              }}
            />
          )}
          {/* Home's one line is short on room: the plug shows once an account is connected. */}
          {accounts.length > 0 && connectorsButton}
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
              {connectorsButton}
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
  const navItem = (label: string, d: string, on: boolean, run: () => void, panel = false, muted = false, badge = "") => (
    <button
      key={label}
      onClick={() => {
        run();
        setSidebar(false);
      }}
      aria-current={on && !panel ? "page" : undefined}
      aria-pressed={panel ? on : undefined}
      className={`flex h-12 w-full items-center gap-4 rounded-2xl px-4 text-start text-[16px] transition ${
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
      {/* Long names wrap to two lines; next to a badge they're cut short instead, and shown in full on hover. */}
      <span className={`min-w-0 ${badge ? "truncate" : "leading-tight"}`} title={badge ? label : undefined}>
        {label}
      </span>
      {badge && <span className="ms-auto shrink-0 rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] font-medium text-zinc-400">{badge}</span>}
    </button>
  );

  return (
    <>
    <div className="flex h-full" inert={Boolean(addScreen)}>
      {/* Sidebar */}
      <aside
        className={`${sidebar ? "flex" : "hidden"} fixed inset-0 z-[35] w-full flex-col overflow-y-auto bg-zinc-950 md:static md:m-3 md:me-0 md:flex md:w-[256px] md:shrink-0 md:rounded-[26px] md:bg-transparent md:glass`}
      >
        <div className="flex items-start justify-between px-5 pb-1 pt-6">
          <button onClick={goHome} className="flex items-center gap-2 text-left" aria-label={t("Flash Infinity AI, home")}>
            <span className="-ml-1 [filter:drop-shadow(0_4px_10px_rgb(91_140_246/0.35))]">
              <BrandMark size={56} id="flash-side" />
            </span>
            <span className="min-w-0">
              <Wordmark tm className="block text-[28px] font-bold leading-none tracking-tight text-white" />
              {/* In the narrow sidebar the tagline's two halves take a line each, so it never breaks mid-phrase. */}
              <span className="mt-1.5 block text-[11.5px] leading-snug text-zinc-400">
                <span className="md:block">{t("One Workspace.")}</span> <span className="md:block">{t("Infinite Possibilities.")}</span>
              </span>
            </span>
          </button>
          <button className="mt-1 text-zinc-400 md:hidden" onClick={() => setSidebar(false)} aria-label={t("Close menu")}>
            ✕
          </button>
        </div>
        <nav aria-label="Flash" className="mt-7 space-y-1.5 px-3">
          {navItem(t("Home"), ICONS.home, isHome, goHome)}
          {navItem(t("AI Chat"), ICONS.chat, !isHome, openChats)}
          {navItem(t("Create"), ICONS.create, false, () => setTemplates(""))}
          {navItem(t("Voice"), ICONS.voice, Boolean(voice), () => setVoice({ woke: false }), true)}
          {navItem(t("Images"), ICONS.images, false, () => setShowCreations("image"))}
          {navItem(t("Workspace"), ICONS.workspace, false, () => setShowApps(true))}
          {navItem(t("Automations"), ICONS.bolt, false, () => setShowAutomations(true), false, false, t("Soon"))}
        </nav>
        <div className="mx-5 my-4 border-t border-white/[0.07]" />
        <nav aria-label={t("Library and settings")} className="space-y-1 px-3">
          {navItem(t("Library"), ICONS.library, false, () => setShowCreations("all"), false, true)}
          {navItem(t("Brand Hub"), ICONS.brand, false, () => setSettingsTab("brand"), false, true)}
          {navItem(t("Settings"), ICONS.settings, false, () => setSettingsTab("general"), false, true)}
        </nav>
        {/* Home lists the chats itself, so on a computer its sidebar stays as calm as the menu above. */}
        {isHome && <div className="hidden md:block md:flex-1" />}
        <div className={`mt-4 flex items-center justify-between px-5 ${isHome ? "md:hidden" : ""}`}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{t("Chats")}</p>
          <button
            onClick={() => {
              goHome();
              pickTool("auto");
            }}
            aria-label={t("New chat")}
            title={t("New chat")}
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
              placeholder={t("Search chats")}
              aria-label={t("Search projects and chats")}
              className="h-9 w-full rounded-xl border border-white/8 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-primary/70"
            />
          </div>
        )}
        <nav aria-label={t("Chats")} className={`mt-1.5 shrink-0 space-y-0.5 px-3 md:min-h-[7.5rem] md:flex-1 md:shrink md:overflow-y-auto ${isHome ? "md:hidden" : ""}`}>
          {projectQuery.trim() && !sorted.length && !inChats.length && <p className="px-2 py-1.5 text-xs text-zinc-500">{t("Nothing matches.")}</p>}
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center rounded-lg text-sm ${p.id === activeId ? "bg-white/[0.06] text-white" : "text-zinc-300 hover:bg-white/[0.03]"}`}
            >
              <button className="min-w-0 flex-1 truncate px-3 py-1.5 text-start" onClick={() => openProject(p.id)}>
                {p.pinned && (
                  <span className="me-1.5 text-[11px]" aria-label={t("Pinned")}>
                    📌
                  </span>
                )}
                {projectName(p.name)}
              </button>
              <button
                className="px-1 text-zinc-500 hover:text-zinc-200 md:hidden md:group-focus-within:block md:group-hover:block"
                onClick={() => togglePin(p.id)}
                aria-label={p.pinned ? t("Unpin project") : t("Pin project")}
                title={p.pinned ? t("Unpin") : t("Pin to the top")}
              >
                {p.pinned ? "⊘" : "📌"}
              </button>
              <button
                className="px-1 text-zinc-500 hover:text-zinc-200 md:hidden md:group-focus-within:block md:group-hover:block"
                onClick={() => renameProject(p.id)}
                aria-label={t("Rename project")}
              >
                ✎
              </button>
              <button
                className="px-2 text-zinc-500 hover:text-red-400 md:hidden md:group-focus-within:block md:group-hover:block"
                onClick={() => deleteProject(p.id)}
                aria-label={t("Delete project")}
              >
                🗑
              </button>
            </div>
          ))}
          {inChats.length > 0 && (
            <>
              <p className="px-2 pt-3 pb-1 text-xs font-medium text-zinc-500">{t("In your chats")}</p>
              {inChats.map((h) => (
                <button
                  key={h.id}
                  onClick={() => openProject(h.id)}
                  className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition ${h.id === activeId ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
                >
                  <span className="block truncate text-zinc-200">{projectName(h.name)}</span>
                  <span className="line-clamp-2 text-xs text-zinc-500">
                    {h.role === "user" ? t("You: {text}", { text: h.snippet }) : t("Flash: {text}", { text: h.snippet })}
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
                  <span aria-hidden>👑</span> {t("Upgrade to Pro")}
                </p>
                <p className="mt-0.5 text-[13px] text-zinc-400">{t("More power. More possibilities.")}</p>
                <button
                  onClick={() => {
                    setShowCredits(true);
                    setSidebar(false);
                  }}
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand transition hover:brightness-110"
                >
                  {t("Get Started")} <Icon d={ICONS.arrow} className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          <button
            onClick={() => setShowInvite(true)}
            className={`w-full rounded-lg px-2 py-1 text-start text-xs text-gold-soft transition hover:bg-white/[0.04] hover:text-gold ${isHome ? "md:hidden" : ""}`}
          >
            🎁 {t("Invite friends, earn credits")}
          </button>
          {status && (
            <details className={`px-2 text-xs text-zinc-400 ${isHome ? "md:hidden" : ""}`}>
              <summary className="cursor-pointer select-none hover:text-zinc-200">
                ✨{" "}
                {liveCount === ENGINES.length
                  ? t("What Flash can do")
                  : t("What Flash can do · {count} coming soon", { count: (ENGINES.length - liveCount).toLocaleString(t.locale) })}
              </summary>
              <div className="mt-2 grid max-h-36 grid-cols-2 gap-1 overflow-y-auto">
                {ENGINES.map((e) => (
                  <span key={e} className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${status[e] ? "bg-emerald-400" : "bg-zinc-600"}`} />
                    {t(ENGINE_LABELS[e])}
                    {!status[e] && <span className="text-zinc-500">{t("coming soon")}</span>}
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
            {t("Drop a file for Flash to read, analyse or transcribe")}
          </div>
        )}
        <header className={`flex h-16 shrink-0 items-center gap-2 px-4 sm:gap-3 md:h-[76px] md:px-6 ${isHome ? "mx-auto w-full max-w-[1600px] lg:px-8" : ""}`}>
          <button
            className="-ml-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-300 hover:bg-white/[0.05] md:hidden"
            onClick={() => setSidebar(true)}
            aria-label={t("Open menu")}
          >
            <Icon d="M4 7h16 M4 12h16 M4 17h16" />
          </button>
          {isHome ? (
            <>
              <button onClick={goHome} className="shrink-0 md:hidden" aria-label={t("Flash Infinity AI, home")}>
                <BrandMark size={32} id="flash-top" />
              </button>
              <div ref={searchBoxRef} className="relative hidden min-w-0 max-w-2xl flex-[3] md:block @min-[1100px]/main:max-w-[760px]">
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
                  placeholder={t("Search anything... chats, projects, prompts or tools")}
                  aria-label={t("Search your chats, projects, prompts and tools")}
                  className="glass h-12 w-full rounded-2xl pl-12 pr-4 text-[15px] text-zinc-100 shadow-none outline-none placeholder:text-zinc-400 focus:border-primary/50 @min-[700px]/main:pr-16 @min-[1100px]/main:h-[52px]"
                />
                <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-sans text-[11px] text-zinc-400 @min-[700px]/main:block">
                  {mac ? "⌘ K" : "Ctrl K"}
                </kbd>
                {searchOpen && (
                  <div className="absolute left-0 right-0 top-full z-40 mt-2 max-h-[60vh] overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl light:shadow-black/10">
                    {!projectQuery.trim() && sorted.length > 0 && (
                      <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">{searchOpen === "all" ? t("All chats") : t("Recent chats")}</p>
                    )}
                    {toolHits.length > 0 && <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">{t("Tools")}</p>}
                    {toolHits.map((f) => (
                      <button
                        key={f.title}
                        onClick={() => {
                          setProjectQuery("");
                          openFeature(f.action);
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                      >
                        <Icon d={ICONS[f.icon]} className="h-4 w-4 shrink-0 text-zinc-400" />
                        <span className="min-w-0 flex-1 truncate">{t(f.title)}</span>
                        {f.soon && <span className="shrink-0 text-xs text-zinc-500">{t("Coming soon")}</span>}
                      </button>
                    ))}
                    {promptHits.length > 0 && <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">{t("Prompts")}</p>}
                    {promptHits.map((template) => (
                      <button
                        key={template.id}
                        onClick={() => {
                          setSearchOpen(false);
                          setProjectQuery("");
                          setTemplates(template.id);
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                      >
                        <Icon d={ICONS.template} className="h-4 w-4 shrink-0 text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate">{t(template.name)}</span>
                      </button>
                    ))}
                    {(toolHits.length > 0 || promptHits.length > 0) && sorted.length > 0 && (
                      <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-zinc-500">{t("Chats")}</p>
                    )}
                    {(searchOpen === "all" || projectQuery.trim() ? sorted : sorted.slice(0, 10)).map((p) => (
                      <button
                        key={p.id}
                        onClick={() => openFromSearch(p.id)}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                      >
                        <Icon d={ICONS.chat} className="h-4 w-4 shrink-0 text-zinc-500" />
                        <span dir="auto" className="min-w-0 flex-1 truncate">{projectName(p.name)}</span>
                        <span className="shrink-0 text-xs text-zinc-500">{timeAgo(p.updated_at, Date.now(), t.locale)}</span>
                      </button>
                    ))}
                    {inChats.length > 0 && (
                      <>
                        <p className="px-3 pb-1 pt-2 text-xs font-medium text-zinc-500">{t("In your chats")}</p>
                        {inChats.map((h) => (
                          <button
                            key={h.id}
                            onClick={() => openFromSearch(h.id)}
                            className="block w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/[0.06]"
                          >
                            <span className="block truncate text-zinc-200">{projectName(h.name)}</span>
                            <span className="line-clamp-2 text-xs text-zinc-500">
                              {h.role === "user" ? t("You: {text}", { text: h.snippet }) : t("Flash: {text}", { text: h.snippet })}
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                    {!sorted.length && !inChats.length && !toolHits.length && !promptHits.length && (
                      <p className="px-3 py-2 text-sm text-zinc-500">{projectQuery.trim() ? t("Nothing matches.") : t("Your chats will show here.")}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1" />
            </>
          ) : (
            <h1 dir="auto" className="min-w-0 flex-1 truncate text-[15px] font-medium text-zinc-100">{active ? projectName(active.name) : <Wordmark />}</h1>
          )}
          {beside && (
            <button
              onClick={() => setPanelHidden((hidden) => !hidden)}
              aria-controls="flash-preview"
              aria-expanded={!panelHidden}
              aria-label={panelHidden ? t("Show preview") : t("Hide preview")}
              title={panelHidden ? t("Show preview") : t("Hide preview")}
              className={`inline-flex h-[26px] w-[30px] shrink-0 items-center justify-center rounded-full border transition ${
                panelHidden ? "border-white/10 text-zinc-200 hover:bg-white/[0.05]" : "border-primary/40 bg-primary/10 text-primary-soft hover:bg-primary/20"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 rtl:-scale-x-100" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M14 4v16" />
              </svg>
            </button>
          )}
          {active?.messages && (
            <button
              onClick={() => setShowInstructions(true)}
              title={
                active.instructions
                  ? t("Instructions: {text}", { text: active.instructions.slice(0, 120) })
                  : t("Tell Flash how to answer in this project")
              }
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${
                active.instructions ? "border-primary/40 bg-primary/10 text-primary-soft hover:bg-primary/20" : "border-white/10 text-zinc-200 hover:bg-white/[0.05]"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 6h16 M4 12h10 M4 18h7 M17 15l2 2 4-4" />
              </svg>
              <span className={headerWords}>{active.instructions ? t("Instructions on") : t("Instructions")}</span>
            </button>
          )}
          {active?.messages?.some((m) => !m.pending) && <DownloadChat project={active} disabled={busy} />}
          {active?.messages?.some((m) => !m.pending) && (
            <button
              onClick={() => setShowShare(true)}
              disabled={busy}
              title={t("Share a link to this chat")}
              aria-label={t("Share")}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 15V3 M7 8l5-5 5 5 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>
              <span className={headerWords}>{t("Share")}</span>
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
            title={t("Credits: see costs and top up")}
          >
            <BoltIcon className="h-3.5 w-3.5 text-gold" /> {me.credits.toLocaleString(t.locale)}
            <span className="hidden @min-[900px]/main:inline">{t("credits")}</span>
          </button>
          {isHome && <Bell me={me} onSites={() => setShowApps(true)} onCredits={() => setShowCredits(true)} />}
          <AccountMenu
            me={me}
            placement="down"
            greet={isHome}
            switching={switching}
            out={loggingOut}
            onSettings={() => setSettingsTab("general")}
            onHelp={() => setCompanion(true)}
            onPlan={() => setShowCredits(true)}
            onInvite={() => setShowInvite(true)}
            onSwitch={(id) => switchAccount(id)}
            onAdd={() => openAdding({})}
            onSignOut={() => signOut()}
            onSignOutAll={signOutAll}
          />
        </header>
        {showApps && (
          <MyApps
            onClose={() => setShowApps(false)}
            onEdit={(id) => {
              setShowApps(false);
              setNotice(t("Ask for your changes here, then press Update site under the new version."));
              openProject(id);
            }}
            // Only where plans can be bought: not before payments are on, nor inside the Android app (see android-shell.ts).
            onPlans={
              me.paymentsEnabled || me.testPurchases
                ? () => {
                    setShowApps(false);
                    setShowCredits(true);
                  }
                : undefined
            }
          />
        )}
        {showAutomations && <Automations onTemplates={() => setTemplates("")} onClose={() => setShowAutomations(false)} />}
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
        <InstallPopup besidePreview={panelShown} />
        {install.dialog}
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
          leaving={loggingOut !== null}
          onSignOut={(everywhere, next) => {
            // Logged out of every device already: Settings closes as the tab goes on. Log out saves
            // what it can first: Settings stays open saying so, and closes if the tab stays.
            if (everywhere) setSettingsTab(null);
            void signOut(everywhere, next).then((left) => left || setSettingsTab(null));
          }}
          onCompanionShown={(shown) => setHideCompanion(!shown)}
          onWakeWord={setWakeOn}
          onClose={closeSettings}
        />
      )}
      {chooser && (
        <AccountChooser
          title={chooserTitle(chooser)}
          accounts={chooser.accounts}
          switching={switching}
          onChoose={(id) => void switchAccount(id, { gone: true })}
          onAdd={() => addFromChooser(chooser)}
          again={chooser.reason === "gone" && chooser.email ? { email: chooser.email, name: chooser.name, onChoose: () => signInAgain(chooser) } : undefined}
        />
      )}
      {unsaved && (
        <SwitchAnyway
          onSwitch={unsaved.go}
          onCancel={() => {
            setUnsaved(null);
            setSwitching(null);
            // Staying: the menu lists the account just added, to switch to once this is saved.
            if (unsaved.added) void checkAccounts();
          }}
          writing={unsaved.writing}
        />
      )}
      {showInstructions && active && (
        <ProjectInstructions
          project={active}
          onSaved={(instructions) => setProjects((list) => list.map((p) => (p.id === active.id ? { ...p, instructions } : p)))}
          onClose={() => setShowInstructions(false)}
        />
      )}

        {showPanel && !beside && (
          // On a phone or a narrow window, the chat or the preview, with the message box under both.
          <div className="flex h-11 shrink-0 items-center justify-center px-4">
            <div role="tablist" aria-label={t("Preview")} className="flex rounded-md border border-zinc-800 text-xs text-zinc-400">
              {(["chat", "preview"] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={tab === v}
                  aria-controls={v === "preview" ? "flash-preview" : undefined}
                  onClick={() => showPhoneTab(v)}
                  className={`inline-flex min-w-24 items-center justify-center gap-1.5 px-4 py-1.5 ${tab === v ? "bg-primary/15 text-primary-soft" : "hover:text-zinc-200"}`}
                >
                  {v === "chat" ? t("Conversation") : t("Preview")}
                  {v === "preview" && building && <span className="h-1.5 w-1.5 motion-safe:animate-pulse rounded-full bg-emerald-400" aria-hidden />}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* What's said takes up to half the room it shares with the chat (or the preview), so a screen
            with little height (a phone held sideways) keeps the chat in view; beyond that it scrolls
            on its own, its edge faded. Its one column is the width it is given, never wider: a long
            line of code, a link or a table in the chat scrolls inside it, as in the flex column it replaced.
            Above the chat, the room its faded edge needs reaches under the chat (-mb-2), so Home and the
            chat sit where they did under a notice that scrolled with them. */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[fit-content(50%)_minmax(0,1fr)]">
        {said && (
          <div className={`mx-auto w-full overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,#000_calc(100%-0.5rem),transparent)] ${tab === "preview" ? "max-w-3xl space-y-2 px-3 pb-2" : `-mb-2 space-y-3 px-4 pb-2 pt-2 ${isHome ? "max-w-[1600px] sm:px-6 lg:px-8" : "max-w-3xl"}`}`}>{said}</div>
        )}
        <div className="relative row-start-2 flex min-h-0 flex-col">
        {/* Under the preview on a phone, the chat keeps its place (and where it was scrolled to) out of sight. */}
        <div
          inert={tab === "preview"}
          className={`min-h-0 flex-1 overflow-y-auto ${tab === "preview" ? "invisible" : ""} ${isHome ? "[mask-image:linear-gradient(to_bottom,transparent,#000_16px)]" : ""}`}
        >
          {(!me.verified || allOff) && (
            <div className={`mx-auto space-y-3 px-4 ${said ? "pt-3" : "pt-2"} ${isHome ? "max-w-[1600px] sm:px-6 lg:px-8" : "max-w-3xl"}`}>
            {me && !me.verified && <VerifyBanner email={me.user.email} free={me.freeMonthly} failed={emailFailed} />}
            {allOff && (
              <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                {t("Flash is taking a short break, so answers are paused and nothing uses credits. Please check back soon.")}
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
              onFeature={openFeature}
              level={level}
              onLevel={(next) => {
                setLevel(next);
                // A level is for writing, research and building, so a picture or sound tool gives way to Auto.
                if (choice !== "auto" && !LEVEL_ENGINES.includes(choice)) setChoice("auto");
              }}
              installable={install.available}
              shortcuts={!voice}
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
                  // Not while the server is still finishing the reply below it.
                  onEdit={m.role === "user" && !m.local && !busy && !all[i + 1]?.pending && i === all.findLastIndex((x) => x.role === "user") ? editLast : undefined}
                  onBuyCredits={() => setShowCredits(true)}
                  paymentsOn={me.paymentsEnabled || me.testPurchases}
                  language={me.user.language}
                  onPublished={(slug) => setAppSlug(m.id, slug)}
                  publishedEarlier={m.app && !m.app.slug ? all.slice(0, i).findLast((x) => x.app?.slug)?.app?.slug : undefined}
                  onUseImage={busy ? undefined : editImage}
                  onReshape={busy || attachment || all[i - 1]?.attachmentName ? undefined : reshape}
                  onEditApp={m.app && !m.pending ? (html) => editAppCode(m.id, html) : undefined}
                  // Flash builds on the latest app, so fixes and picked parts are for that one.
                  onFixApp={m.app && !m.pending && !busy && m.id === lastAppId ? (request) => fixApp(m.app!.kind, request) : undefined}
                  onPickApp={m.app && !m.pending && m.id === lastAppId ? (part) => pickApp(m.app!.kind, part) : undefined}
                  onAction={m.actions?.length ? (card) => updateCard(m.id, card) : undefined}
                  onContinue={
                    i === all.length - 1 && !m.pending && !busy && active && continuable(m, active.id).length ? () => continueWith(m.id) : undefined
                  }
                  // The latest app runs in the live preview only, so it's never two copies with their own state.
                  onShowApp={m.id === lastAppId || (m.id === building?.id && !panelShown) ? showPreview : undefined}
                  appShown={m.id === lastAppId && (panelShown || tab === "preview")}
                  appReplaced={m.id === lastAppId && drafting}
                />
              ))}
              {/* Scrolled to with the padding under it, so the last line clears the companion's button. */}
              <div ref={bottomRef} className="scroll-mb-6" />
            </div>
          )}
        </div>
        {showPanel && !beside && (
          // Kept in place while the chat shows, so the app keeps its state between looks.
          <section
            id="flash-preview"
            aria-label={t("Preview")}
            className={`${tab === "preview" ? "flex" : "hidden"} absolute inset-x-3 inset-y-1 flex-col overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900`}
          >
            {panel}
          </section>
        )}
        </div>
        </div>

        {(!isHome || voice) && (
          <div className="px-4 pb-4 pt-2">
            {/* The closed companion button sits on top of this when the preview is beside the chat. */}
            <div ref={setDock} className="relative mx-auto max-w-3xl">
              {queueList}
              {voicePanel || form}
              {!voice && (
                <p className="mt-2 hidden text-center text-xs text-zinc-500 sm:block">
                  {t("Enter to send · Shift + Enter for a new line · drop or paste files anywhere")}
                </p>
              )}
            </div>
          </div>
        )}
        {/* Outside the message box, so Add files works while the voice panel shows too. */}
        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={onFile} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      </main>

      {beside && (
        // Not the glass utility: its backdrop filter would hold the app's full screen inside the panel.
        <section
          id="flash-preview"
          aria-label={t("Preview")}
          className={`${panelHidden ? "hidden" : "flex"} my-3 me-3 w-[clamp(26rem,36vw,40rem)] shrink-0 flex-col overflow-y-auto rounded-[26px] border border-[var(--glass-line)] [background-image:var(--glass-1)] shadow-[var(--glass-shadow)]`}
        >
          {panel}
        </section>
      )}

      {(!hideCompanion || companion) && !(tab === "preview" && !companion) && (
      <Companion
        open={companion}
        onOpen={() => setCompanion(true)}
        onClose={() => setCompanion(false)}
        context={companionContext}
        onQueue={queueRequest}
        onPage={openCompanionPage}
        onCost={refreshMe}
        running={busy ? { engine: runningMsg?.engine, status: runningMsg?.status } : null}
        dock={panelShown ? dock : null}
      />
      )}
    </div>
    {addScreen && adding && (
      <AddOver label={adding.again ? t("Welcome back") : t("Add another account")} onBack={() => addBack(adding)}>
        {addScreen}
      </AddOver>
    )}
    </>
  );
}
