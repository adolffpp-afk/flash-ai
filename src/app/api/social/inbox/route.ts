import { guard, problem, readBody, reply, str } from "@/lib/server/social-routes.ts";
import { listInbox, refreshInbox } from "@/lib/server/social.ts";

/* Check for new comments, mentions, messages and reviews now: every free inbox, or one account's (X's costs credits, so only this way). */
export const maxDuration = 60;

export async function POST(request: Request) {
  const g = await guard(request, true);
  if (g instanceof Response) return g;
  const body = await readBody(request);
  try {
    const added = await refreshInbox(g.user.id, str(body.accountId, 40));
    return reply({ added, inbox: await listInbox(g.user.id) });
  } catch (err) {
    return problem(err, g.t, "inbox");
  }
}
