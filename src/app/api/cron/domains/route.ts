import { fromCron } from "@/lib/server/domain-orders.ts";
import { checkDomains } from "@/lib/server/domain-checks.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The daily domain check (vercel.json): end dates, confirmed registrants, moved domains, and their reminder emails. */
export async function GET(request: Request) {
  if (!fromCron(request)) return new Response("Unauthorized", { status: 401 });
  return Response.json({ checked: await checkDomains() });
}
