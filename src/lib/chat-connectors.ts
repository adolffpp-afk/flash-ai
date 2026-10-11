import { CONNECTION_ID, MAX_CONNECTIONS } from "./connectors.ts";

/*
 * Which of the user's connected accounts are on in a chat, kept with the chat on this device (like
 * the level). Nothing is on until the user turns it on; a new chat starts with none.
 */

const key = (projectId: string) => `flash-connectors:${projectId}`;

/** Only well-formed ids, at most MAX_CONNECTIONS of them, each once. */
export const cleanIds = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && CONNECTION_ID.test(id)))].slice(0, MAX_CONNECTIONS) : [];

export function readChatConnectors(projectId: string): string[] {
  try {
    return cleanIds(JSON.parse(localStorage.getItem(key(projectId)) ?? "[]"));
  } catch {
    return [];
  }
}

export function writeChatConnectors(projectId: string, ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(key(projectId), JSON.stringify(cleanIds(ids)));
    else localStorage.removeItem(key(projectId));
  } catch {
    // Storage blocked: the choice lasts until the page is closed.
  }
}
