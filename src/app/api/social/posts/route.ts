import { after } from "next/server";
import { guard, problem, readBody, reply, str } from "@/lib/server/social-routes.ts";
import { cancelPost, createPost, sendDue } from "@/lib/server/social.ts";

/* A new post, to one or more accounts, now or at a time picked (POST); cancel what of one hasn't gone out yet (DELETE). */
export const maxDuration = 300;

export async function POST(request: Request) {
  const g = await guard(request, true);
  if (g instanceof Response) return g;
  const body = await readBody(request);
  try {
    const made = await createPost(g.user.id, {
      text: str(body.text),
      title: str(body.title, 200),
      link: str(body.link, 2100),
      fileId: str(body.fileId, 60),
      accountIds: Array.isArray(body.accountIds) ? body.accountIds.slice(0, 30).map((x) => str(x, 40)) : [],
      at: typeof body.at === "number" ? body.at : 0,
    });
    // Due now: sent after this answer, within this function's time (the social tick sends what's left).
    if (made.dueNow) after(() => sendDue({ postId: made.id }).then(() => undefined, (err) => console.error("[flash] social send failed", err instanceof Error ? err.name : "error")));
    return reply({ id: made.id });
  } catch (err) {
    return problem(err, g.t, "post");
  }
}

export async function DELETE(request: Request) {
  const g = await guard(request, true);
  if (g instanceof Response) return g;
  const body = await readBody(request);
  try {
    return reply({ cancelled: await cancelPost(g.user.id, str(body.id, 40)) });
  } catch (err) {
    return problem(err, g.t, "cancel");
  }
}
