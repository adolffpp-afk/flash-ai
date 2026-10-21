import { bodyOf, estimate, gate } from "@/lib/server/automation-api.ts";

/** Prices a draft (counted with the automations key, kept a day), saving nothing but its own rate-limit row. */
export async function POST(request: Request) {
  const g = await gate(request, { write: true, limit: "estimate" });
  if (g instanceof Response) return g;
  return estimate(g, await bodyOf(request));
}
