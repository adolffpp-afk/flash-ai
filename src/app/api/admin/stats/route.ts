import { getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { adminStats } from "@/lib/server/admin-stats.ts";

export const dynamic = "force-dynamic";

/** Owner dashboard numbers for a time range (see adminStats). */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });

  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 30));
  return Response.json(await adminStats(days));
}
