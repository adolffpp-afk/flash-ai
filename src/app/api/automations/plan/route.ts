import { bodyOf, gate } from "@/lib/server/automation-api.ts";
import { planAutopilot } from "@/lib/server/autopilot-plan.ts";

/* The Autopilot's planner: { goal, answers?, timeZone, acceptedCredits } becomes its questions or a plan, priced first (autopilot-plan.ts). Shares "Describe it"'s limit. */
export async function POST(request: Request) {
  const g = await gate(request, { write: true, limit: "draft" });
  if (g instanceof Response) return g;
  return planAutopilot(g, await bodyOf(request));
}
