import type { BuiltApp, Engine, Source } from "./types";
import type { Post } from "./post-pack";

export type UIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachmentName?: string;
  // A request made from a template: the engine it goes to, the template's name, and its model if it needs one.
  template?: { engine: Engine; name: string; model?: string };
  // A request the companion lined up: it goes to Auto, whatever tool is picked in the composer.
  queued?: boolean;
  // Sent by a one-tap button (like "Copy the text" under a photo): it goes to Auto too.
  auto?: boolean;
  // An invoice or quote built in the browser: exact and free, so it is never sent to the AI again.
  local?: boolean;
  // Said out loud in a voice conversation, so the answer comes back in a few spoken sentences.
  voice?: boolean;
  // A change to the latest app or deck (Fix it, or a part picked in its preview): it goes to the builder.
  build?: "app" | "slides";
  // The part of the app the user picked in the preview: its name for the chat, and what the builder is told.
  picked?: { label: string; context: string };
  // Sent with the picture from Flash's last reply, as a follow-up like "make it darker": that picture's
  // link, so Retry and Go ahead can fetch it again after a reload (true in chats saved before links were kept).
  pictureAbove?: boolean | string;
  engine?: Engine;
  reason?: string;
  demo?: boolean;
  cost?: number;
  model?: string;
  modelWhy?: string;
  free?: boolean;
  images?: { url: string; prompt: string; label?: string }[];
  videos?: { url: string; prompt: string }[];
  // A social post pack's posts, for their Copy buttons.
  posts?: Post[];
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

// empty: no messages yet (from the list, before the chat itself loads).
export type ProjectSummary = { id: string; name: string; updated_at: number; pinned?: boolean; instructions?: string; empty?: boolean };
export type Project = ProjectSummary & { messages: UIMessage[] };

export type Pricing = {
  costs: Record<Engine, number>;
  // Typical credits for each written template, by id.
  templates?: Record<string, number>;
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
  freeLane: { chats: number; images: number; transcripts?: number };
  paymentsEnabled: boolean;
  domainsEnabled: boolean;
  testPurchases: boolean;
  models: { id: string; engine: Engine; label: string; credits: number; blurb: string; live: boolean }[];
};

export type Me = Pricing & {
  // language: the one Flash answers in (see languages.ts), "" for Automatic.
  user: { id: string; email: string; name: string; nickname?: string; work?: string; language?: string; preferences: string };
  hasPassword?: boolean;
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
    // The referrer's bonuses still waiting out pendingDays after the friend's payment.
    pending: { credits: number; availableAt: number }[];
    friendShare: number;
    referrerShare: number;
    referrerCap: number;
    pendingDays: number;
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
