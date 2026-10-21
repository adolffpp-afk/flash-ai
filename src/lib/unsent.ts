/*
 * Words written and not sent yet outside the message box: an Edit of a message, a question for Ask
 * Flash. They live in their own boxes only, so those say here while they hold some, and Flash asks
 * before going on as another account, as for the message box (see leaveCheck in Flash.tsx).
 */
const open = new Set<string>();

/** A box (by its id) holds words not sent, or no longer does (sent, cancelled, emptied or closed). */
export function markUnsent(box: string, unsent: boolean): void {
  if (unsent) open.add(box);
  else open.delete(box);
}

/** Whether any such box on this page holds words not sent. */
export const hasUnsent = (): boolean => open.size > 0;
