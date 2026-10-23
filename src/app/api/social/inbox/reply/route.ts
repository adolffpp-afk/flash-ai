import { guard, problem, readBody, reply, str } from "@/lib/server/social-routes.ts";
import { replyToItem } from "@/lib/server/social.ts";

/* Answers one inbox item on its own network (an X reply costs credits like a post). */
export async function POST(request: Request) {
  const g = await guard(request, true);
  if (g instanceof Response) return g;
  const body = await readBody(request);
  try {
    return reply({ item: await replyToItem(g.user.id, str(body.id, 40), str(body.text, 6000)) });
  } catch (err) {
    return problem(err, g.t, "reply");
  }
}
