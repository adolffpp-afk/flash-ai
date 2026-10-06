import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { usageSummary } from "@/lib/server/usage.ts";

export const dynamic = "force-dynamic";

/** Settings > Usage: credits spent this month by tool, and free requests left today. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json(await usageSummary(user.id));
}
