import { bodyOf, createAutomation, gate, listAutomations } from "@/lib/server/automation-api.ts";

/*
 * The account's automations: the list, and a new one at the price the user saw (409 price_changed
 * when it went up). Admins reach these, and everyone else once /admin's switch opens automations to
 * all (see gate in automation-api.ts).
 */
export async function GET(request: Request) {
  const g = await gate(request, { limit: "list" });
  if (g instanceof Response) return g;
  return Response.json(await listAutomations(g));
}

export async function POST(request: Request) {
  const g = await gate(request, { write: true, limit: "create" });
  if (g instanceof Response) return g;
  return createAutomation(g, await bodyOf(request));
}
