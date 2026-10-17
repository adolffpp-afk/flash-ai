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
