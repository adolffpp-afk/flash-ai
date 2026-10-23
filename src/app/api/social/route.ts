import { guard, problem, reply } from "@/lib/server/social-routes.ts";
import { listAccounts, listInbox, listPosts, readyNetworks } from "@/lib/server/social.ts";

/* The Social hub as the page shows it: the networks that can be connected, the user's accounts, posts and inbox. */
export async function GET(request: Request) {
  const g = await guard(request, false);
  if (g instanceof Response) return g;
  try {
    const [accounts, posts, inbox] = await Promise.all([listAccounts(g.user.id), listPosts(g.user.id), listInbox(g.user.id)]);
    return reply({ networks: readyNetworks(), accounts, posts, inbox });
  } catch (err) {
    return problem(err, g.t, "list");
  }
}
