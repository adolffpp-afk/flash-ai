import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { settledCharge } from "@/lib/server/credits.ts";

export const dynamic = "force-dynamic";

/**
 * What a request was finally charged, for a reply the user stopped: the reply's header then shows
 * what it really cost. credits is null while the charge is still held.
 */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ credits: null }, { status: 400 });
  return Response.json({ credits: await settledCharge(user.id, id) });
}
