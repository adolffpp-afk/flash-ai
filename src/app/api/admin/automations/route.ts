import { bodyOf, burnIn, burnInSpec, createAutomation, gate, runNow } from "@/lib/server/automation-api.ts";
import { estimateSpec } from "@/lib/server/automation-estimate.ts";
import { isAdmin } from "@/lib/server/auth.ts";
import { validTimeZone } from "@/lib/context-note.ts";
import { randomId } from "@/lib/server/ids.ts";

/*
 * The burn-in card on /admin (admins only). GET is the card: setup, cron health, the admin's test
 * automations, their runs with holds, and the notices they made. POST:
 * - { action: "price", prompt?, level?, mode?, timeZone } prices the three test automations, saving
 *   nothing;
 * - { action: "make", kind: "once" | "daily" | "manual", prompt?, level?, mode?, timeZone, seenMax }
 *   makes one at the price the admin saw (409 price_changed when it went up), and with kind "manual"
 *   and run: true runs it once now as well.
 */
export const maxDuration = 800;

export async function GET(request: Request) {
  const g = await gate(request, { limit: "admin" });
  if (g instanceof Response) return g;
  if (!isAdmin(g.user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  return Response.json(await burnIn(g));
}

const LEVELS = ["sonic", "ascend", "vision", "ultra"] as const;
const MODES = ["write", "research", "quick"] as const;
const KINDS = ["once", "daily", "manual"] as const;
const DEFAULT_PROMPT = "Write two sentences about today's date and one thing that happened on this day in history.";

export async function POST(request: Request) {
  const g = await gate(request, { write: true, limit: "admin" });
  if (g instanceof Response) return g;
  if (!isAdmin(g.user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  const body = await bodyOf(request);
  const timeZone = validTimeZone(body.timeZone) ?? "UTC";
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim().slice(0, 4000) : DEFAULT_PROMPT;
  const level = LEVELS.find((l) => l === body.level) ?? "sonic";
  const mode = MODES.find((m) => m === body.mode) ?? "write";
  const priced = async (kind: (typeof KINDS)[number]) => {
    const { spec, name } = burnInSpec(kind, timeZone, prompt, level, mode);
    return { spec, name, estimate: await estimateSpec(spec, g.user, { name, time_zone: timeZone, where_json: "{}", language: g.user.language ?? "" }) };
  };
  if (body.action === "price") {
    const [once, daily, manual] = await Promise.all(KINDS.map(priced));
    return Response.json({ prices: { once: once.estimate, daily: daily.estimate, manual: manual.estimate } });
  }
  const kind = KINDS.find((k) => k === body.kind);
  if (body.action !== "make" || !kind) return Response.json({ error: "Choose one of the test automations." }, { status: 400 });
  const { spec, name } = burnInSpec(kind, timeZone, prompt, level, mode);
  // Saved only at the price the admin saw: createAutomation prices it again and answers 409 if it went up.
  const made = await createAutomation(g, { spec, name, timeZone, seenMax: body.seenMax });
  if (made.status !== 201 || kind !== "manual" || body.run !== true) return made;
  const { automation } = (await made.clone().json()) as { automation: { id: string } };
  return runNow(g, automation.id, { requestId: randomId(12), seenMax: body.seenMax });
}
