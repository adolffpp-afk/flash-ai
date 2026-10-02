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
  free?: boolean;
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
  plans: {
    id: string;
    name: string;
    priceCents: number;
    yearlyPriceCents: number;
    credits: number;
    blurb: string;
    features: string[];
    // Team plans: people who share the monthly credits, the owner included.
    seats?: number;
  }[];
  freeMonthly: number;
  freeLane: { chats: number; images: number };
  paymentsEnabled: boolean;
  testPurchases: boolean;
  models: { id: string; engine: Engine; label: string; credits: number; blurb: string; live: boolean }[];
};

export type Me = Pricing & {
  user: { id: string; email: string; name: string; preferences: string };
  isAdmin: boolean;
  verified: boolean;
  credits: number;
  plan: {
    id: string;
    name: string;
    interval: "month" | "year";
    credits: number;
    nextCredits: number;
    renews: boolean;
    paidUntil: number;
    test: boolean;
  } | null;
  activity: { amount: number; reason: string; created_at: number }[];
  // A team member's shared pool balance (included in credits), or null.
  teamCredits: number | null;
  team: TeamInfo;
  referral: {
    link: string;
    joined: number;
    rewarded: number;
    earned: number;
    friendShare: number;
    referrerShare: number;
    referrerCap: number;
  };
};

export type TeamInfo =
  | {
      role: "owner";
      active: boolean;
      seats: number;
      members: { id: string; name: string; email: string; joined_at: number; used: number }[];
      invites: { id: string; email: string; expires_at: number }[];
    }
  | { role: "member"; active: boolean; owner: string }
  | null;

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status, code: data.code });
  }
  return data as T;
}
