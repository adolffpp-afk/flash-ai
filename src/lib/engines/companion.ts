import type Anthropic from "@anthropic-ai/sdk";
import { ROUTER_MODEL, getClient, type Meter } from "./claude.ts";
import { COMPANION_MAX_TOKENS, COMPANION_STEPS, COMPANION_TOOL_TOKENS, claudeCostCents, companionStepCents } from "../credits.ts";
import { COMPANION_PAGES, type CompanionAction, type CompanionEvent, type CompanionTurn } from "../companion.ts";

// The companion answers on Haiku: quick, and a typical answer costs about 2 credits.
export const COMPANION_MODEL = process.env.FLASH_COMPANION_MODEL || ROUTER_MODEL;

// A tool's answer is cut to about COMPANION_TOOL_TOKENS, as the hold assumes.
const MAX_TOOL_CHARS = COMPANION_TOOL_TOKENS * 2;

/**
 * Tokens a text can take at most, without asking Claude: about 2.5 English characters a token,
 * and a whole token for every byte of anything else (Chinese or Arabic text, emoji), since a
 * token never covers less than a byte. Used when counting fails, and for tool answers.
 */
export function tokensAtMost(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) ascii++;
    else other += code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return Math.ceil(ascii / 2.5) + other;
}

export const COMPANION_TOOLS: Anthropic.Tool[] = [
  {
    name: "do_next",
    description:
      "Adds a request to the user's Next up list. Flash runs it in their chat as soon as the current job ends, or right away " +
      "when nothing is running, at its usual price. Use only when the user asked for this work in their own words.",
    input_schema: {
      type: "object",
      properties: { request: { type: "string", description: "The full request, written the way the user would type it in the chat." } },
      required: ["request"],
    },
  },
  {
    name: "open_page",
    description: "Opens a page or panel of Flash for the user.",
    input_schema: {
      type: "object",
      properties: { page: { type: "string", enum: Object.keys(COMPANION_PAGES) } },
      required: ["page"],
    },
  },
  {
    name: "my_websites",
    description: "The user's published websites and apps: links, page views, unread form messages, open orders and recent sales.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "my_creations",
    description: "The newest pictures, videos and sounds Flash made for the user, with links.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "my_spending",
    description: "How many credits the user spent in the last 7 and 30 days, and on what.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_chats",
    description: "Finds the user's chats that mention some words.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

/** The input tokens of the companion's first call, tools included, counted by Claude (or estimated on the high side). */
export async function countCompanionTokens(turns: CompanionTurn[], systemPrompt: string, model = COMPANION_MODEL): Promise<number> {
  const messages = turns.map((t) => ({ role: t.role, content: t.content }));
  try {
    const res = await getClient().messages.countTokens({ model, system: systemPrompt, messages, tools: COMPANION_TOOLS });
    return res.input_tokens;
  } catch {
    return tokensAtMost(systemPrompt + turns.map((t) => t.content).join("")) + tokensAtMost(JSON.stringify(COMPANION_TOOLS)) + 100;
  }
}

/** What running a tool gives back: text for the model, and an action for the app, if any. */
export type ToolOutcome = { result: string; action?: CompanionAction; status?: string };
export type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<ToolOutcome>;

/**
 * Streams the companion's answer. When it calls tools, they run and it answers again with what
 * they returned, for up to COMPANION_STEPS calls, and only while the credits held (capCents)
 * still cover the next call at its most expensive.
 */
export async function* streamCompanion(
  turns: CompanionTurn[],
  systemPrompt: string,
  runTool: ToolRunner | null,
  meter: Meter,
  capCents: number,
  model = COMPANION_MODEL,
): AsyncGenerator<CompanionEvent> {
  const messages: Anthropic.MessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));
  let spent = 0;
  let wrote = false;
  for (let step = 0; step < COMPANION_STEPS; step++) {
    const stream = getClient().messages.stream({
      model,
      max_tokens: COMPANION_MAX_TOKENS,
      system: systemPrompt,
      messages,
      ...(runTool && { tools: COMPANION_TOOLS }),
    });
    let gap = wrote;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
        // Text from a later step starts a new paragraph.
        yield { type: "text", delta: (gap ? "\n\n" : "") + event.delta.text };
        gap = false;
        wrote = true;
      }
    }
    const final = await stream.finalMessage();
    const cents = claudeCostCents(final.model, final.usage);
    meter("anthropic", final.model, cents);
    spent += cents;
    if (final.stop_reason === "refusal") {
      yield { type: "text", delta: "\n\nThe companion can't help with that." };
      return;
    }
    if (final.stop_reason !== "tool_use" || !runTool) return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of final.content) {
      if (block.type !== "tool_use") continue;
      const outcome = await runTool(block.name, (block.input ?? {}) as Record<string, unknown>).catch((err) => {
        console.error(`[flash] companion tool ${block.name} failed`, err);
        return { result: "That lookup failed. Tell the user to try again in a moment." } as ToolOutcome;
      });
      if (outcome.status) yield { type: "status", message: outcome.status };
      if (outcome.action) yield { type: "action", action: outcome.action };
      const text = outcome.result.length > MAX_TOOL_CHARS ? outcome.result.slice(0, MAX_TOOL_CHARS) + "\n(cut short)" : outcome.result;
      results.push({ type: "tool_result", tool_use_id: block.id, content: text });
    }
    messages.push({ role: "assistant", content: final.content }, { role: "user", content: results });
    // The next call re-reads everything so far, plus what the tools returned.
    const nextInput =
      final.usage.input_tokens + final.usage.output_tokens + results.reduce((n, r) => n + tokensAtMost(String(r.content)), 0);
    if (step === COMPANION_STEPS - 1 || spent + companionStepCents(model, nextInput) > capCents) {
      yield { type: "text", delta: (wrote ? "\n\n" : "") + "That's as far as this answer can go. Ask again to continue." };
      return;
    }
  }
}
