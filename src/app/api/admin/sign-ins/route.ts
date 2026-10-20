import { getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { signInCounts, signInLog } from "@/lib/server/sign-ins.ts";

export const dynamic = "force-dynamic";

/**
 * The owner dashboard's Sign-ins tab: how many accounts signed in, used Flash and were made, and the
 * sign-in log, newest first. q searches it by email or name; before (a row id) gets the next page,
 * without the counts again.
 */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").slice(0, 200);
  const before = Math.max(0, Math.floor(Number(params.get("before")) || 0));
  const log = await signInLog(q, before);
  return Response.json(before ? { log } : { counts: await signInCounts(), log });
}
