/*
 * A team invitation link opened in Flash (?invite=) waits here until it can be joined. One opened
 * before signing in waits in localStorage until an account loads. One for another account signed
 * in here waits only in the tab that opened it (sessionStorage), so other tabs and accounts don't
 * ask too, and is joined once that tab switches to the account. Storage that refuses (a private
 * window, blocked site data) keeps nothing: the link can be opened again after signing in.
 */
const KEY = "flash_invite";

const browserArea = () => localStorage;
const tabArea = () => sessionStorage;

function read(area: () => Storage): string | null {
  try {
    return area().getItem(KEY);
  } catch {
    return null;
  }
}

function write(area: () => Storage, token: string | null): void {
  try {
    if (token === null) area().removeItem(KEY);
    else area().setItem(KEY, token);
  } catch {
    // Kept nowhere.
  }
}

/** An invitation link just opened: joined once an account loads. */
export const saveInvite = (token: string) => write(browserArea, token);

/** The invitation waiting to be joined: this tab's own first (one for the account it switched to), else the browser's. */
export const waitingInvite = (): string | null => read(tabArea) ?? read(browserArea);

/** An invitation for another account signed in here: kept in this tab only, until it switches to that account. */
export function keepInviteInTab(token: string): void {
  write(browserArea, null);
  write(tabArea, token);
}

/** Forgets the invitation waiting (joined, refused, or put away), in this tab and in the browser. */
export function forgetInvite(): void {
  write(browserArea, null);
  write(tabArea, null);
}
