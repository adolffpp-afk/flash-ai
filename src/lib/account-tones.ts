/*
 * Each account signed in to this browser keeps its badge colour (an index into AccountMenu's
 * TONES) for as long as it stays signed in here, whichever accounts are added or log out around
 * it, so a colour never moves to another account while a tab shows it. The colours are kept in
 * localStorage, which every tab of this browser shares, so all of them agree. Storage that
 * refuses keeps them for this page.
 */

const KEY = "flash-account-tones";
// A user id, as the server checks it (ACCOUNT_ID in server/auth.ts).
const ID = /^[A-Za-z0-9_-]{1,64}$/;

type Tones = [id: string, tone: number][];

/**
 * The colours of these accounts (ids, in the order they were added), from the ones kept (saved).
 * An account keeps its colour. A new one takes the first colour no account kept here has had,
 * else the first one no listed account uses, which the unlisted account it was kept for gives up.
 * Kept accounts that aren't listed (logged out here, or a list another tab hasn't refreshed yet)
 * keep theirs until then, so a tab still showing one never sees its colour on another account.
 */
export function keepTones(saved: Tones, ids: string[], count: number): Tones {
  const listed = new Set(ids);
  const kept = new Map<string, number>();
  const taken = new Set<number>();
  // Listed accounts' colours first, so one of them wins a colour two were kept with.
  const valid = saved.filter(([id, tone]) => ID.test(id) && Number.isInteger(tone) && tone >= 0 && tone < count);
  for (const [id, tone] of [...valid.filter(([id]) => listed.has(id)), ...valid.filter(([id]) => !listed.has(id))]) {
    if (kept.has(id) || taken.has(tone)) continue;
    kept.set(id, tone);
    taken.add(tone);
  }
  for (const id of ids) {
    if (kept.has(id)) continue;
    let tone = [...Array(count).keys()].find((i) => !taken.has(i));
    if (tone === undefined) {
      const inUse = new Set(ids.filter((x) => kept.has(x)).map((x) => kept.get(x)));
      tone = [...Array(count).keys()].find((i) => !inUse.has(i)) ?? 0;
      for (const [other, t] of kept) if (t === tone && !listed.has(other)) kept.delete(other);
    }
    kept.set(id, tone);
    taken.add(tone);
  }
  return [...kept];
}

let memory: Tones = [];

function read(): Tones {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number");
  } catch {
    // Storage refused, or not ours: this page's copy.
  }
  return memory;
}

function forget(): void {
  memory = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage refused: this page's copy is gone.
  }
}

/**
 * Each listed account's colour, kept for this browser's tabs. An account keeps its colour once the
 * others log out too. One alone with no colour kept for it, on a browser that never held two or
 * whose accounts have all logged out since, has Flash's own (the first), as on a fresh browser, and
 * nothing is kept for it yet: the colours of the accounts no longer here are let go.
 */
export function accountTones(ids: string[], count: number): Map<string, number> {
  const before = read();
  if (ids.length < 2 && !before.some(([id]) => ids.includes(id))) {
    if (before.length) forget();
    return new Map(ids.map((id) => [id, 0]));
  }
  const next = keepTones(before, ids, count);
  memory = next;
  if (JSON.stringify(next) !== JSON.stringify(before)) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Kept for this page only.
    }
  }
  return new Map(next);
}
