// The versions of the apps and decks Flash built in a chat, for the preview's History, and the free
// message that makes an earlier one the newest again, so the next change builds on it.
import { msg } from "./i18n.ts";
import type { UIMessage } from "./store.ts";

export type AppVersion = { id: string; n: number; title: string };

// Said on the message that brings a version back. It costs nothing and no AI writes it.
export const BROUGHT_BACK = msg("Version {n} is the newest again. Flash builds on it from here.");
export const BROUGHT_BACK_WHY = msg("An earlier version, brought back for free.");

/** The chat's finished versions, oldest first, numbered from 1. */
export function appVersions(messages: UIMessage[]): AppVersion[] {
  const list: AppVersion[] = [];
  for (const m of messages) if (m.app && !m.pending) list.push({ id: m.id, n: list.length + 1, title: m.app.title });
  return list;
}

/**
 * The message that puts version id back on top: a copy of its file, with no site of its own (Publish
 * then updates the site an earlier version went live on, see siteOf). Null when there's no such version.
 */
export function bringBack(messages: UIMessage[], id: string, newId: string, say: (n: number) => string): UIMessage | null {
  const version = appVersions(messages).find((v) => v.id === id);
  const app = messages.find((m) => m.id === id)?.app;
  if (!version || !app) return null;
  return {
    id: newId,
    role: "assistant",
    content: say(version.n),
    engine: app.kind,
    reason: BROUGHT_BACK_WHY,
    cost: 0,
    local: true,
    app: { title: app.title, html: app.html, kind: app.kind },
  };
}
