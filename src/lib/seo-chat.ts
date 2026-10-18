import type { UIMessage } from "./store.ts";

/*
 * Where a change the search check (SEO) asks for would go, in the chat that built the site (see
 * fixSite in Flash.tsx). Kept apart from seo-fix.ts, which reads the page and loads only when used.
 */

/** A chat's newest app, and the site it updates: its own, or the one an earlier version was published as (as AppPreview does). */
export function newestApp(messages: UIMessage[]) {
  const at = messages.findLastIndex((m) => m.app);
  const latest = at === -1 ? undefined : messages[at].app;
  return { latest, site: latest && (latest.slug ?? messages.slice(0, at).findLast((m) => m.app?.slug)?.app?.slug) };
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
 * own copy is used when it has changes of its own not saved yet (unsaved: they're saved in a moment,
 * and the server's copy would lose them), or when the server's can't be read. busy: Flash is still
 * writing a reply in either copy (see stillAnswering), so nothing should be sent yet. adopt: the
 * server's copy has something this page's doesn't, so the page should show it.
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
