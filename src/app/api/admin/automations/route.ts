import { bodyOf, burnIn, burnInSpec, createAutomation, deleteAutomation, gate, LIMITS, overRunLimits, runNow } from "@/lib/server/automation-api.ts";
import { estimateSpec } from "@/lib/server/automation-estimate.ts";
import { isAdmin } from "@/lib/server/auth.ts";
import { validTimeZone } from "@/lib/context-note.ts";
import { randomId } from "@/lib/server/ids.ts";
import { overLimit } from "@/lib/server/limits.ts";

/*
 * The burn-in card on /admin (admins only). GET is the card: setup, cron health, the admin's test
 * automations, their runs with holds, and the notices they made. POST:
 * - { action: "price", prompt?, level?, mode?, timeZone } prices the three test automations, saving
 *   nothing;
 * - { action: "make", kind: "once" | "daily" | "manual", prompt?, level?, mode?, timeZone, seenMax }
 *   makes one at the price the admin saw (409 price_changed when it went up), and with kind "manual"
 *   and run: true runs it once now as well. Making counts against Save's limit and running against
 *   Run now's; one made to run that is refused (no credits, say) is deleted again, so a refused Run
 *   once now leaves nothing behind.
 */
export const maxDuration = 800;

export async function GET(request: Request) {
  // The card polls this every 5 s while a run goes on: its own limit, so its buttons (POST) keep theirs.
  const g = await gate(request, { limit: "card" });
  if (g instanceof Response) return g;
  if (!isAdmin(g.user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
  return Response.json(await burnIn(g));
}

const LEVELS = ["sonic", "ascend", "vision", "ultra"] as const;
const MODES = ["write", "research", "quick"] as const;
const KINDS = ["once", "daily", "manual"] as const;
const DEFAULT_PROMPT = "Write two sentences about today's date and one thing that happened on this day in history.";

export async function POST(request: Request) {
  const body = await bodyOf(request);
  // Pricing as the form changes counts against the estimate's limit (as the editor's does), so writing
  // an instruction never uses up what making a test may.
  const g = await gate(request, { write: true, limit: body.action === "price" ? "estimate" : "admin" });
  if (g instanceof Response) return g;
  if (!isAdmin(g.user)) return Response.json({ error: "Only the owner can see this." }, { status: 403 });
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
  const run = kind === "manual" && body.run === true;
  const [max, windowMs] = LIMITS.create;
  if (await overLimit(`auto:create:${g.user.id}`, max, windowMs)) return Response.json({ error: g.t("Too many requests. Try again in an hour.") }, { status: 429 });
  // A new automation has no runs of its own yet: the account's limit is the one to count.
  const limited = run ? await overRunLimits(g, null) : null;
  if (limited) return limited;
  const { spec, name } = burnInSpec(kind, timeZone, prompt, level, mode);
  // Saved only at the price the admin saw: createAutomation prices it again and answers 409 if it went up.
  const made = await createAutomation(g, { spec, name, timeZone, seenMax: body.seenMax });
  if (made.status !== 201 || !run) return made;
  const { automation } = (await made.clone().json()) as { automation: { id: string } };
  const ran = await runNow(g, automation.id, { requestId: randomId(12), seenMax: body.seenMax });
  // Refused (no credits, the month's limit, setup missing): nothing ran, so the test made for it goes again.
  if (ran.status >= 400) await deleteAutomation(g, automation.id);
  return ran;
}
