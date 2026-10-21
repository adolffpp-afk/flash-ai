import {
  ACCOUNT_HEADER,
  accountsCookie,
  clearSessionCookie,
  endSession,
  fromOwnPage,
  heldTokens,
  isSecure,
  jarSessions,
  oldPageLogout,
  removeFromJar,
  resolveSession,
} from "@/lib/server/auth.ts";
import { endAllSessions } from "@/lib/server/account.ts";
import { run } from "@/lib/server/db.ts";
import { sha256 } from "@/lib/server/ids.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { dropSignIns } from "@/lib/server/push.ts";

/**
 * Log out. {} logs the tab's account out of this browser, { everywhere: true } logs it out of every
 * device and disconnects the apps connected to it (Settings > Account), and { all: true } logs this
 * browser out of every account it holds, leaving their other devices signed in. Once a browser
 * holds 2 or more accounts, {} and { everywhere } need the tab's account (X-Flash-Account) and
 * change nothing without it, so a tab showing one account can never log out another. Only Flash's
 * own pages may ask (see fromOwnPage), so another site can't sign a visitor out. A tab loaded
 * before this change logs out with no body (oldPageLogout): that still works from this site while
 * the browser holds one account and names none, as it did then. The alerts each sign-in that ends
 * here turned on in this browser stop with it (see push.ts); the other accounts' stay.
 */
export async function POST(request: Request) {
  const jar = await jarSessions(request);
  const t = await translatorFor(request, jar.byDefault?.user.language);
  const oldPage = !jar.listed && !request.headers.has(ACCOUNT_HEADER) && oldPageLogout(request);
  if (!fromOwnPage(request) && !oldPage) return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { everywhere?: unknown; all?: unknown };
  const headers = new Headers({ "Cache-Control": "no-store" });
  const secure = isSecure(request);

  if (body.all === true) {
    // Every session this browser holds, live or not; the accounts' other devices stay signed in.
    const hashes = heldTokens(request).map((token) => sha256(token));
    await dropSignIns(hashes);
    if (hashes.length) await run(`DELETE FROM sessions WHERE token_hash IN (${hashes.map(() => "?").join(", ")})`, hashes);
    headers.append("Set-Cookie", clearSessionCookie());
    headers.append("Set-Cookie", accountsCookie([], secure));
    return Response.json({ ok: true, next: null }, { headers });
  }

  const everywhere = body.everywhere === true;
  // Nothing live here (a browser whose sessions all ended): as before, only the cookie goes.
  if (!jar.entries.length) {
    await endSession(request);
    headers.append("Set-Cookie", clearSessionCookie());
    if (jar.stale) headers.append("Set-Cookie", accountsCookie([], secure));
    return Response.json({ ok: true, next: null }, { headers });
  }
  const target = await resolveSession(request);
  if (!target) {
    // The tab's account isn't here anymore, or the tab named none while several are: change nothing.
    const named = request.headers.has(ACCOUNT_HEADER);
    return Response.json(
      { error: t(named ? "That account isn't signed in on this browser anymore." : "Reload Flash, then log out again."), code: "account_required" },
      { status: 409, headers },
    );
  }
  // This browser's page takes the account's alerts off its own screen (logOutHere in push.ts).
  if (everywhere) await endAllSessions(target.user.id, sha256(target.token));
  else {
    await dropSignIns([sha256(target.token)]);
    await run("DELETE FROM sessions WHERE token_hash = ?", [sha256(target.token)]);
  }
  const { cookies, next } = await removeFromJar(request, [target.user.id]);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json({ ok: true, next: next ? { id: next.user.id, email: next.user.email } : null }, { headers });
}
