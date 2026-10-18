/*
 * What the bell in the top bar lists, and whether its dot shows (see Bell.tsx): new messages from
 * the forms on the person's published sites, credits running low, an app's AI turning visitors away
 * for lack of credits, and credits added lately.
 */
import type { Me } from "./store";

const DAY = 24 * 60 * 60 * 1000;
// Below this the bell and Home say the credits are running low even with the low-credit emails off,
// and the dot stays until the balance is back up (NEARLY_OUT in server/low-balance.ts).
export const NEARLY_OUT = 10;
// Credits added in the last two weeks show in the list; older ones are in Settings > Usage.
export const RECENT = 14 * DAY;
// An app's AI turning visitors away shows for a week after the last one, unless credits came since.
export const AI_OUT_SHOWN = 7 * DAY;

// aiOutOfCredits: when the app's AI last turned a visitor away because the owner is out of credits (0: it answers).
export type BellSite = { slug: string; title: string; unread: number; aiOutOfCredits?: number };

type Account = Pick<Me, "credits" | "lowCredits" | "activity">;

/** Whether the credits are running low: below the level the person's low-credit emails go at (me.lowCredits). */
export const runningLow = (me: Account) => me.credits < (me.lowCredits ?? NEARLY_OUT);

/**
 * The bell's items at now (0 before the browser knows the time): seen is when the list was last
 * opened, lowSeen whether it was opened since the balance went below the level. Running low shows
 * the dot until the list is opened once, and for as long as nearly nothing is left.
 */
export function bellState(me: Account, sites: BellSite[], now: number, seen: number, lowSeen: boolean) {
  const unread = sites.filter((s) => s.unread > 0);
  const low = runningLow(me);
  const added = now ? me.activity.filter((a) => a.amount > 0 && now - a.created_at < RECENT).slice(0, 5) : [];
  // An app's AI is still turning visitors away if no credits came since it last did. The server leaves
  // out an app whose owner got credits since (inbox.ts); this also hides it as soon as /api/me has them.
  const toppedUp = Math.max(0, ...me.activity.filter((a) => a.amount > 0).map((a) => a.created_at));
  const aiOut = now ? sites.filter((s) => (s.aiOutOfCredits ?? 0) > toppedUp && now - (s.aiOutOfCredits ?? 0) < AI_OUT_SHOWN) : [];
  const fresh =
    unread.length > 0 ||
    (low && (me.credits < NEARLY_OUT || !lowSeen)) ||
    aiOut.some((s) => (s.aiOutOfCredits ?? 0) > seen) ||
    added.some((a) => a.created_at > seen);
  const empty = !unread.length && !low && !aiOut.length && !added.length;
  return { unread, low, added, aiOut, fresh, empty };
}
