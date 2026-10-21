/*
 * What a visitor typed in the landing page's message box waits here while they sign up or sign in,
 * then fills Home's message box (with the tool they picked) once their account loads. It's kept in
 * this tab's sessionStorage, so it never shows for someone else on a shared computer later. Storage
 * that refuses (a private window, blocked site data) keeps nothing: they type it again.
 */
import type { Engine } from "./types.ts";

const KEY = "flash_idea";

export type Idea = { text: string; choice: Engine | "auto" };

/** Keeps the visitor's idea for after they sign in. */
export function keepIdea(idea: Idea): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ text: idea.text.slice(0, 4000), choice: idea.choice }));
  } catch {
    // Kept nowhere.
  }
}

/** The idea waiting for Home's message box, once: it's gone after this. */
export function takeIdea(): Idea | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const idea = JSON.parse(raw) as Partial<Idea>;
    return typeof idea.text === "string" && typeof idea.choice === "string" ? { text: idea.text, choice: idea.choice } : null;
  } catch {
    return null;
  }
}
