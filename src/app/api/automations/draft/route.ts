import { bodyOf, gate } from "@/lib/server/automation-api.ts";
import { draftAutomation } from "@/lib/server/automation-draft.ts";

/* "Describe it": { text, timeZone, acceptedCredits } becomes the editor's form, priced first (automation-draft.ts). */
export async function POST(request: Request) {
  const g = await gate(request, { write: true, limit: "draft" });
  if (g instanceof Response) return g;
  return draftAutomation(g, await bodyOf(request));
}
