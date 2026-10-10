import { getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { MAX_FIXED_COSTS, addFixedCost, fixedCosts, readFixedCost, removeFixedCost } from "@/lib/server/profit.ts";

export const dynamic = "force-dynamic";

async function owner(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  return null;
}

/** The bills the owner pays every month or year, for the dashboard's Net profit. */
export async function GET(request: Request) {
  const denied = await owner(request);
  if (denied) return denied;
  return Response.json({ costs: await fixedCosts() });
}

/** Adds a bill: { name, amount (US dollars), per: "month" | "year" }. */
export async function POST(request: Request) {
  const denied = await owner(request);
  if (denied) return denied;
  const cost = readFixedCost(await request.json().catch(() => ({})));
  if ("error" in cost) return Response.json({ error: cost.error }, { status: 400 });
  if (!(await addFixedCost(cost))) {
    return Response.json({ error: `You can list up to ${MAX_FIXED_COSTS} bills.` }, { status: 409 });
  }
  return Response.json({ costs: await fixedCosts() });
}

/** Removes a bill: ?id=<id>. */
export async function DELETE(request: Request) {
  const denied = await owner(request);
  if (denied) return denied;
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Which bill?" }, { status: 400 });
  await removeFixedCost(id);
  return Response.json({ costs: await fixedCosts() });
}
