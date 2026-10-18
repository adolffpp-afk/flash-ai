import type { BuiltApp, Engine, Source } from "./types";
import type { Post } from "./post-pack";
import type { ActionCard, ConnectorUse } from "./connectors";
import { tNow } from "./use-t.ts";
import { accountHeaders, getPin, setPin } from "./account-pin.ts";

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
  // A Continue on approved cards: their ids, so Retry continues with the same results, after a reload too.
  continues?: string[];
  // Sent by Fix all in the search check (SEO): the most it said this change would hold ("Up to N
  // credits"), so it never holds or is charged more, on Retry and after a reload too.
  cap?: number;
  engine?: Engine;
  // A spoken reply about the app or deck before it, which the next follow-up may still change.
  about?: Engine;
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
  // The connected accounts' tools the reply used, and the calls it asked the user to approve.
  connectors?: ConnectorUse[];
  actions?: ActionCard[];
  error?: string;
  errorCode?: string;
  // A request waiting for its price to be agreed: what Flash decided for it and the price it asked
  // (the model and its credits), sent back with Go ahead or a spoken yes so exactly that runs.
  decided?: { engine: Engine; fresh?: boolean; model?: string; credits?: number };
  // The id of the credits held for the request, so a stopped reply can show what it really cost.
  charge?: number;
  pending?: boolean;
  // When the server started on a reply it saved as pending, so a reply its server never finished
  // stops showing as in progress (see turns.ts).
  pendingSince?: number;
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
  // An extra person on a team plan: its price and the credits it adds each month, and the most a plan can add.
  extraSeat?: { priceCents: number; yearlyPriceCents: number; credits: number; max: number };
  freeMonthly: number;
  freeLane: { chats: number; images: number; transcripts?: number };
  paymentsEnabled: boolean;
  domainsEnabled: boolean;
  // Connectors are set up on this server (see secret-box.ts).
  connectorsEnabled?: boolean;
  testPurchases: boolean;
  models: { id: string; engine: Engine; label: string; credits: number; blurb: string; live: boolean }[];
};

/** One of the accounts this browser is signed in to, as the profile menu lists them. */
export type AccountSummary = { id: string; email: string; name: string; nickname: string };

export type Me = Pricing & {
  // The account this tab shows, and every account this browser is signed in to (see account-pin.ts).
  account: string;
  accounts: AccountSummary[];
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
    // People added on top of a team plan's own seats.
    extraSeats?: number;
    nextCredits: number;
    renews: boolean;
    paidUntil: number;
    test: boolean;
  } | null;
  activity: { amount: number; reason: string; created_at: number }[];
  // A team member's shared pool balance (included in credits), or null.
  teamCredits: number | null;
  // Below this balance the bell and Home say the credits are running low: the level the person's
  // low-credit emails go at (see low-balance.ts).
  lowCredits?: number;
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

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a request goes to Flash itself: a path, or an address on this page's own origin. */
function ownAddress(input: string | URL): boolean {
  const text = String(input);
  if (text.startsWith("/") && !text.startsWith("//")) return true;
  try {
    return typeof window !== "undefined" && new URL(text, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
let pinning: Promise<void> | null = null;
let checked = false;

/**
 * Gives a tab with no account yet the browser's default, once: a page other than Flash's own (like
 * /admin) that is about to change something, which the server refuses without one once several
 * accounts are signed in here.
 */
export function ensurePin(): Promise<void> {
  if (getPin() || checked) return Promise.resolve();
  pinning ??= fetch("/api/auth/accounts", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ default?: string | null }>) : null))
    .then((list) => {
      if (list?.default && !getPin()) setPin(list.default);
    })
    .catch(() => {})
    .finally(() => {
      checked = true;
      pinning = null;
    });
  return pinning;
}

/**
 * fetch for Flash's own API, naming this tab's account (see account-pin.ts). When the server says
 * the tab is signed out, Flash checks whether its account was logged out here (flash:account-check).
 */
export async function authedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  // Only Flash's own address hears which account a tab shows (a picture's link can be elsewhere).
  if (!ownAddress(input)) return fetch(input, init);
  if (!READS.has((init.method ?? "GET").toUpperCase())) await ensurePin();
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(accountHeaders())) headers.set(name, value);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 && getPin() && typeof window !== "undefined") {
    res
      .clone()
      .json()
      .then((body: { code?: string }) => {
        if (body?.code === "signed_out") window.dispatchEvent(new Event("flash:account-check"));
      })
      .catch(() => {});
  }
  return res;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  // The caller's headers stay, with the JSON type added when sending JSON.
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const res = await authedFetch(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The server's message comes in the language Flash is shown in; this one is for a reply with none (a proxy's error page).
    throw Object.assign(new Error(data.error ?? tNow("Request failed ({status})", { status: res.status })), { status: res.status, code: data.code, data });
  }
  return data as T;
}

const UNPUBLISHED = "flash:unpublished";

/** Tells what's on screen (an app's own page in the chat) that a site was unpublished in My websites & apps. */
export function announceUnpublished(slug: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(UNPUBLISHED, { detail: slug }));
}

/** Calls back with each site unpublished on this page; returns what stops it. */
export function onUnpublished(callback: (slug: string) => void): () => void {
  const listener = (e: Event) => callback(String((e as CustomEvent).detail));
  window.addEventListener(UNPUBLISHED, listener);
  return () => window.removeEventListener(UNPUBLISHED, listener);
}

const RESTORED = "flash:restored";

/**
 * Tells what's on screen (an app's own page in the chat) that an earlier version of a site was brought
 * back in My websites & apps (History): the version published from there isn't the live one any more.
 */
export function announceRestored(slug: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(RESTORED, { detail: slug }));
}

/** Calls back with each site an earlier version was brought back for on this page; returns what stops it. */
export function onRestored(callback: (slug: string) => void): () => void {
  const listener = (e: Event) => callback(String((e as CustomEvent).detail));
  window.addEventListener(RESTORED, listener);
  return () => window.removeEventListener(RESTORED, listener);
}

const SEO = "flash:seo";
type SeoScore = { score: number | null; issues: number };

/**
 * Tells what's on screen (an app's own page in the chat) the search check's score of a site's live
 * page, read in My websites & apps: after a version was brought back there, or the check was opened.
 */
export function announceSeoScore(slug: string, seo: SeoScore): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SEO, { detail: { slug, seo } }));
}

/** Calls back with each site's score announced on this page; returns what stops it. */
export function onSeoScore(callback: (slug: string, seo: SeoScore) => void): () => void {
  const listener = (e: Event) => {
    const { slug, seo } = (e as CustomEvent<{ slug: string; seo: SeoScore }>).detail;
    callback(slug, seo);
  };
  window.addEventListener(SEO, listener);
  return () => window.removeEventListener(SEO, listener);
}
