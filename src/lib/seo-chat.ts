import type { UIMessage } from "./store.ts";

/*
 * Where a change the search check (SEO) asks for would go, in the chat that built the site (see
 * fixSite in Flash.tsx), and the price its panel says. Kept apart from seo-fix.ts, which reads the page
 * and loads only when used.
 */

/**
 * The site the version at messages[at] updates: the one it was published as, else the one an earlier
 * version was (AppPreview's Update site), when it's a later version of that app: of the same kind, and
 * every version between them too (Flash builds each on the one before). A deck made after a website, or
 * a website made from that deck, never replaces it. Undefined when there's none.
 */
export function siteOf(messages: UIMessage[], at: number): string | undefined {
  const app = messages[at]?.app;
  if (!app) return undefined;
  if (app.slug) return app.slug;
  for (let i = at - 1; i >= 0; i--) {
    const earlier = messages[i].app;
    if (!earlier) continue;
    if (earlier.kind !== app.kind) return undefined;
    if (earlier.slug) return earlier.slug;
  }
  return undefined;
}

/** A chat's newest app, and the site it updates (see siteOf). */
export function newestApp(messages: UIMessage[]) {
  const at = messages.findLastIndex((m) => m.app);
  const latest = at === -1 ? undefined : messages[at].app;
  return { latest, site: latest && siteOf(messages, at) };
}

/**
 * A chat on this page with a version published as slug, the open one first (null when none has it).
 * The server knows only the chats it has saved, and a chat that published the site a moment ago may
 * not be saved yet (see chatSaves). Chats whose messages aren't loaded here can't be looked in.
 */
export function chatWithSite(chats: { id: string; messages?: UIMessage[] }[], open: string, slug: string): string | null {
  const has = (chat: { messages?: UIMessage[] }) => !!chat.messages?.some((m) => m.app?.slug === slug);
  return (chats.find((c) => c.id === open && has(c)) ?? chats.find(has))?.id ?? null;
}

/**
 * Whether Flash is still writing a reply in a chat: on this page, or on the server after the page that
 * asked for it was left (the chat then comes back with it pending). A change sent now would be made on
 * the copy before that reply, and the reply would land above it, so the change waits until it's done.
 */
export const stillAnswering = (messages: UIMessage[]) => messages.some((m) => m.pending);

// A message as it's saved: what only this page shows (status) and an unset pending left out.
const saved = (m: UIMessage) => JSON.stringify({ ...m, status: undefined, pending: m.pending || undefined });

/**
 * The copy of a chat that a change the search check asks for is decided on and sent from. This page
 * doesn't hear about what another tab or device does in a chat it has open, so the server's copy is
 * read again (load) and used: it has a reply asked there, finished or still being written. This page's
 * own copy is used when it has changes of its own the server may not have yet (unsaved: waiting to be
 * sent, uploading, or a save that failed, see chatSaves; the server's copy would lose them), or when
 * the server's can't be read. busy: Flash is still writing a reply in either copy (see stillAnswering),
 * so nothing should be sent yet. adopt: the server's copy has something this page's doesn't, so the
 * page should show it.
 */
export async function chatForFix(
  here: UIMessage[],
  load: () => Promise<UIMessage[]>,
  unsaved: boolean,
): Promise<{ messages: UIMessage[]; busy: boolean; adopt: boolean }> {
  const server = await load().catch(() => null);
  if (!server || unsaved) return { messages: here, busy: stillAnswering(here) || (server ? stillAnswering(server) : false), adopt: false };
  const same = server.length === here.length && server.every((m, i) => saved(m) === saved(here[i]));
  return { messages: server, busy: stillAnswering(server), adopt: !same };
}

/**
 * What Fix all's change would hold if it were sent now, worked out by the chat route itself from the
 * very request Send makes (quote, see the chat route): credits is the most it can be charged, needed what
 * it needs at least, and available the balance it's held from. Null when it can't be worked out (offline,
 * the count failed, an error, or nothing would be held), so the panel says the usual price instead of a
 * number Flash didn't work out. post is fetch, or a stand-in in tests.
 */
export type FixHold = { credits: number; needed: number; available: number };

export async function fixAllHold(body: object, post: typeof fetch = fetch): Promise<FixHold | null> {
  try {
    const res = await post("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, quote: true }) });
    if (!res.ok) return null;
    const { held, needed, available } = (await res.json()) as Record<string, unknown>;
    const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    return count(held) && held > 0 && count(needed) && count(available) ? { credits: held, needed, available } : null;
  } catch {
    return null;
  }
}

/**
 * The price a change's panel says before Send. Fix it and Add it say what a change typically costs
 * (typical, the pricing table's), with the balance when it's below that (low). Fix all says the most its
 * change can be charged once that's worked out (most), with the balance when it's below what the change
 * needs (short), and while it's being worked out, that (pending); when it can't be, it says what Fix it
 * says. balance is the owner's credits, when known.
 */
export type FixPrice =
  | { kind: "pending" }
  | { kind: "most"; credits: number; short?: number }
  | { kind: "typical"; credits: number; low?: number };

export function fixPrice(all: boolean, hold: FixHold | null | undefined, typical: number, balance?: number): FixPrice {
  if (all && hold === undefined) return { kind: "pending" };
  if (all && hold) return { kind: "most", credits: hold.credits, ...(hold.available < hold.needed && { short: hold.available }) };
  return { kind: "typical", credits: typical, ...(balance !== undefined && balance < typical && { low: balance }) };
}
