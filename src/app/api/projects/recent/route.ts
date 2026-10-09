import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { recentChats } from "@/lib/server/recent.ts";

export const dynamic = "force-dynamic";

/** Home's Recent conversations: the latest chats with something in them. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ chats: await recentChats(user.id) });
}
