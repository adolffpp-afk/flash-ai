import Anthropic from "@anthropic-ai/sdk";
import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { charge, ensureMonthlyCredits, logUsage, settle, spendable } from "@/lib/server/credits.ts";
import { isVerified } from "@/lib/server/account.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { countryOf, recordFree, releaseFreeUser, reserveFree, reserveFreeUser } from "@/lib/server/free.ts";
import { claudeChoice, claudeConfigured, getClient, meterClaude, meterLost, type ClaudeChoice, type Meter } from "@/lib/engines/claude.ts";
import { freeChatConfigured, streamFreeChat } from "@/lib/engines/free.ts";
import { callMaxCents, creditsFor } from "@/lib/credits.ts";
import { autoLevel, isLevel, type ModelLevel } from "@/lib/levels.ts";
import { ENGINES, type Engine } from "@/lib/types.ts";
import { HELPER_TOKENS, cleanIdea, cleanPrompt, helperSystem } from "@/lib/prompt-helper.ts";

export const maxDuration = 60;

const WINDOW = 10 * 60_000;
// Not found, no access yet, rate limited or overloaded: Summit's step-down can still write it.
const UNAVAILABLE = new Set([403, 404, 429, 503, 529]);

// The most one call on a choice can cost: the instructions and the idea read, HELPER_TOKENS written.
const mostCents = (choice: ClaudeChoice, system: string, idea: string) => callMaxCents(choice.model, system.length + idea.length, HELPER_TOKENS);

/** Writes the prompt on a level's model, and on its step-down when that model can't take it. A refusal leaves the idea as it was. */
async function writePrompt(choice: ClaudeChoice, system: string, idea: string, meter: Meter): Promise<{ prompt: string; model: string }> {
  try {
    const res = await getClient()
      .beta.messages.create(
        {
          model: choice.model,
          max_tokens: HELPER_TOKENS,
          // A rewrite needs little thought, and answers fast; no refusal fallback, so the hold covers it.
          output_config: { effort: "low" },
          system,
          messages: [{ role: "user", content: idea }],
        },
        { timeout: 45_000, maxRetries: 0, signal: AbortSignal.timeout(45_000) },
      )
      .catch((err: unknown) => meterLost(err, meter, mostCents(choice, system, idea), choice.model));
    meterClaude(meter, res, choice.model);
    const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "";
    return { prompt: res.stop_reason === "refusal" ? "" : cleanPrompt(text), model: res.model };
  } catch (err) {
    if (!choice.stepDown || !(err instanceof Anthropic.APIError && UNAVAILABLE.has(Number(err.status)))) throw err;
    return writePrompt(choice.stepDown, system, idea, meter);
  }
}

/** Writes the prompt on the free lane, as one of the day's free messages. */
async function writeFree(system: string, idea: string, country: string): Promise<{ prompt: string; model: string; provider: string }> {
  let text = "";
  const used = { model: "", provider: "" };
  const events = streamFreeChat([{ role: "user", content: idea }], "", "text", reserveFree, recordFree, (label, provider) => Object.assign(used, { model: label, provider }), {
    systemPrompt: system,
    country,
    maxTokens: HELPER_TOKENS,
  });
  for await (const e of events) if (e.type === "text") text += e.delta;
  return { prompt: cleanPrompt(text), ...used };
}

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const body = (await request.json().catch(() => null)) as { idea?: unknown; level?: unknown; tool?: unknown } | null;
  const idea = cleanIdea(body?.idea);
  if (!idea) return Response.json({ error: t("Type a few words of your idea first.") }, { status: 400 });
  const tool: Engine | "auto" = ENGINES.includes(body?.tool as Engine) ? (body!.tool as Engine) : "auto";
  if (await overLimit(`prompt-helper:${user.id}`, 30, WINDOW)) {
    return Response.json({ error: t("That's a lot of rewrites at once. Try again in a few minutes.") }, { status: 429 });
  }
  if (!claudeConfigured() && !freeChatConfigured()) return Response.json({ error: t("Prompt Helper isn't available yet.") }, { status: 503 });

  const system = helperSystem(tool);
  // The level picked for the next message, or the one Auto picks for a short written request.
  const level: ModelLevel = isLevel(body?.level) && body.level !== "auto" ? body.level : autoLevel("text", idea).level;
  const choice = claudeChoice("text", level);
  // Held at the most it can cost, on Summit's step-down too; settled at what it really cost.
  const held = creditsFor(Math.max(mostCents(choice, system, idea), choice.stepDown ? mostCents(choice.stepDown, system, idea) : 0));

  await ensureMonthlyCredits(user.id);
  const { largest: available } = await spendable(user.id);
  // Too few credits (or no Claude key): the free lane writes it, as one of today's free messages.
  let free = false;
  if (!claudeConfigured() || available < held) {
    if (!isVerified(user) || !freeChatConfigured()) {
      return Response.json(
        {
          error: !isVerified(user)
            ? t("Prompt Helper needs a few credits. Confirm your email to get your free credits.")
            : t("Prompt Helper needs a few credits. Get more credits to keep using it."),
          code: "out_of_credits",
        },
        { status: 402 },
      );
    }
    if (!(await reserveFreeUser(user.id, "chat"))) {
      return Response.json({ error: t("You've used today's free messages. They reset tomorrow, or get more credits now."), code: "out_of_credits" }, { status: 402 });
    }
    free = true;
  }
  const chargeId = free ? 0 : await charge(user.id, held, "Prompt Helper");
  if (chargeId === null) {
    return Response.json({ error: t("Prompt Helper needs a few credits. Get more credits to keep using it."), code: "out_of_credits" }, { status: 402 });
  }

  const spend: number[] = [];
  const meter: Meter = (_provider, _model, cents) => spend.push(cents);
  let used = { model: choice.model, provider: "anthropic" };
  let prompt = "";
  let ok = true;
  try {
    if (free) {
      const out = await writeFree(system, idea, countryOf(request));
      prompt = out.prompt;
      used = { model: out.model, provider: out.provider };
    } else {
      const out = await writePrompt(choice, system, idea, meter);
      prompt = out.prompt;
      used.model = out.model;
    }
  } catch (err) {
    console.error("[flash] prompt helper failed", err);
    ok = false;
  }
  const costCents = spend.reduce((n, c) => n + c, 0);
  // What the call cost, never more than held; nothing when no call ran.
  const credits = free || costCents <= 0 ? 0 : Math.min(held, creditsFor(costCents));
  if (chargeId) await settle(chargeId, credits);
  if (free && (!ok || !prompt)) await releaseFreeUser(user.id, "chat").catch((err) => console.error("[flash] free release failed", err));
  await logUsage({ userId: user.id, engine: "prompt-helper", model: used.model, provider: used.provider, credits, costCents, ok }).catch((err) =>
    console.error("[flash] usage log failed", err),
  );
  if (!ok || !prompt) {
    const tail = credits ? " " + t("This used {credits} credits for the work already done.", { credits }) : "";
    return Response.json({ error: t("Prompt Helper couldn't rewrite that. Try again in a moment.") + tail }, { status: 502 });
  }
  return Response.json({ prompt, credits, ...(free && { free: true }) });
}
