import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { searchChats } from "@/lib/server/search.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (await overLimit(`search:${user.id}`, 120, 60_000)) return Response.json({ error: "Too many searches. Wait a minute." }, { status: 429 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return Response.json({ results: await searchChats(user.id, q) });
}
