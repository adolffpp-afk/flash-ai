/*
 * Code changed by hand in an app's Code view and not saved yet. It lives in that editor only, so
 * the editors say here while they hold some, and Flash asks before switching account away from it,
 * as for a chat that hasn't saved (see flushSaves in Flash.tsx).
 */
const open = new Set<string>();

/** An editor (by its id) holds unsaved code, or no longer does (saved, undone, or closed). */
export function markCodeDraft(editor: string, unsaved: boolean): void {
  if (unsaved) open.add(editor);
  else open.delete(editor);
}

/** Whether any Code view on this page holds code that isn't saved. */
export const hasCodeDraft = (): boolean => open.size > 0;
