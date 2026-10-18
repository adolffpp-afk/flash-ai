import { defaultCookies, jarSessions } from "@/lib/server/auth.ts";

export const dynamic = "force-dynamic";

/**
 * The accounts this browser is signed in to, in the order they were added, and which is the
 * default. Sessions that ended drop out of the browser's list here, and when the default's ended,
 * the first account left becomes the default: this is the only place that happens, so a tab never
 * finds itself moved to another account by an ordinary request. Needs no tab account: it is how a
 * tab without one, or whose account just ended, finds out what is left.
 */
export async function GET(request: Request) {
  const jar = await jarSessions(request);
  const next = jar.byDefault ?? jar.entries[0] ?? null;
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of defaultCookies(request, jar, next)) headers.append("Set-Cookie", cookie);
  return Response.json(
    {
      default: next?.user.id ?? null,
      accounts: jar.entries.map(({ user }) => ({ id: user.id, email: user.email, name: user.name, nickname: user.nickname ?? "" })),
    },
    { headers },
  );
}
