import type { BuiltApp, Engine, Source } from "./types";

export type UIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachmentName?: string;
  engine?: Engine;
  reason?: string;
  demo?: boolean;
  images?: { url: string; prompt: string }[];
  videos?: { url: string; prompt: string }[];
  audio?: string;
  audioLabel?: string;
  status?: string;
  app?: BuiltApp;
  // Text that arrived after the app, shown below its preview.
  after?: string;
  sources?: Source[];
  error?: string;
  pending?: boolean;
};

export type Project = { id: string; name: string; updatedAt: number; messages: UIMessage[] };

const PROJECTS_KEY = "flash.projects.v1";
const PREFS_KEY = "flash.preferences.v1";

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function newProject(name = "New project"): Project {
  return { id: newId(), name, updatedAt: Date.now(), messages: [] };
}

export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const list = raw ? (JSON.parse(raw) as Project[]) : [];
    return list.map((p) => ({ ...p, messages: p.messages.map((m) => ({ ...m, pending: false })) }));
  } catch {
    return [];
  }
}

function stripMedia(projects: Project[]): Project[] {
  return projects.map((p) => ({
    ...p,
    messages: p.messages.map((m) => ({
      ...m,
      images: m.images?.map((i) => (i.url.startsWith("data:") ? { ...i, url: "" } : i)),
      audio: m.audio?.startsWith("data:") ? "" : m.audio,
    })),
  }));
}

/** Saves projects; if the browser's storage is full, keeps the text and drops generated media. */
export function saveProjects(projects: Project[]): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(stripMedia(projects)));
    } catch {
      // Storage unavailable (private window); the session still works in memory.
    }
  }
}

export function loadPreferences(): string {
  try {
    return localStorage.getItem(PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function savePreferences(value: string): void {
  try {
    localStorage.setItem(PREFS_KEY, value);
  } catch {}
}
