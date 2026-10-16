import { fromOwnPage, getUser, isAdmin, unauthorized, type User } from "@/lib/server/auth.ts";
import { actOnReport, listReports } from "@/lib/server/reports.ts";

export const dynamic = "force-dynamic";

async function adminOf(request: Request): Promise<User | Response> {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  return user;
}

/** Every reported item with its reports, open ones first (the dashboard's Reports tab). */
export async function GET(request: Request) {
  const admin = await adminOf(request);
  if (admin instanceof Response) return admin;
  return Response.json({ items: await listReports() });
}

/** Marks an item's reports reviewed, or takes the item down: { kind, id, action: "reviewed" | "take_down" }. */
export async function POST(request: Request) {
  const admin = await adminOf(request);
  if (admin instanceof Response) return admin;
  // Taking something down is for the dashboard itself, never a form on another site.
  if (!fromOwnPage(request)) return Response.json({ error: "Use the dashboard on Flash's own page." }, { status: 403 });
  const body = ((await request.json().catch(() => null)) ?? {}) as { kind?: unknown; id?: unknown; action?: unknown };
  const result = await actOnReport(admin, body.kind, body.id, body.action);
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ items: await listReports() });
}
