import { fromOwnPage, getUser, isAdmin, unauthorized, type User } from "@/lib/server/auth.ts";
import { adminShowcase, decideShowcase, isDecision, isShowcaseKind } from "@/lib/server/showcase.ts";

export const dynamic = "force-dynamic";

async function adminOf(request: Request): Promise<User | Response> {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  return user;
}

/** Everything offered for the showcase, waiting first (the dashboard's Showcase tab). */
export async function GET(request: Request) {
  const admin = await adminOf(request);
  if (admin instanceof Response) return admin;
  return Response.json({ items: await adminShowcase() });
}

/** Shows, hides or puts back an offered item: { kind, ref, status: "shown" | "hidden" | "waiting" }. */
export async function POST(request: Request) {
  const admin = await adminOf(request);
  if (admin instanceof Response) return admin;
  if (!fromOwnPage(request)) return Response.json({ error: "Use the dashboard on Flash's own page." }, { status: 403 });
  const body = ((await request.json().catch(() => null)) ?? {}) as { kind?: unknown; ref?: unknown; status?: unknown };
  if (!isShowcaseKind(body.kind) || typeof body.ref !== "string" || !isDecision(body.status)) {
    return Response.json({ error: "Say which item and what to do with it." }, { status: 400 });
  }
  if (!(await decideShowcase(body.kind, body.ref, body.status))) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ items: await adminShowcase() });
}
