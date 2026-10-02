import type { BuiltApp, Engine, Source } from "./types";

export type UIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachmentName?: string;
  engine?: Engine;
  reason?: string;
  demo?: boolean;
  cost?: number;
  model?: string;
  modelWhy?: string;
  images?: { url: string; prompt: string }[];
  videos?: { url: string; prompt: string }[];
  audio?: string;
  audioLabel?: string;
  sources?: Source[];
  error?: string;
  errorCode?: string;
  pending?: boolean;
  stopped?: boolean;
  status?: string;
  app?: BuiltApp & { slug?: string };
  // Text that arrived after the app, shown below its preview.
  after?: string;
};

export type ProjectSummary = { id: string; name: string; updated_at: number };
export type Project = ProjectSummary & { messages: UIMessage[] };

export type Pricing = {
  costs: Record<Engine, number>;
  limits: Partial<Record<Engine, number>>;
  packs: { id: string; name: string; credits: number; priceCents: number; blurb: string }[];
  freeMonthly: number;
  paymentsEnabled: boolean;
  models: { id: string; engine: Engine; label: string; credits: number; blurb: string; live: boolean }[];
};

export type Me = Pricing & {
  user: { id: string; email: string; name: string; preferences: string };
  isAdmin: boolean;
  credits: number;
  activity: { amount: number; reason: string; created_at: number }[];
};

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data as T;
}
