/*
 * What an automation's AI step costs: priced exactly as a chat reply at the same level (Write as
 * chat's Write, Research as chat's Research), from src/lib/credits.ts, which this file only reads.
 * The step's system prompt is built here the way streamText and streamSearch build it, so the tokens
 * counted are the tokens sent; the tools a reply may call and the room their definitions take are
 * the chat route's too (see planFor there).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { engineOf, type AiStep } from "../automations.ts";
import { claudePrice, researchPlan, TYPICAL_CREDITS, WEATHER_PLAN, type ToolPlan } from "../credits.ts";
import { claudeChoice, countInputTokens, defaultChoice, system, type ClaudeChoice, type SystemOptions } from "../engines/claude.ts";
import { claudeTool, toolFlags, type ClientTool } from "../research.ts";
import { tokensAtMost } from "../tokens.ts";
import type { ChatTurn } from "../types.ts";

export type StepPrice = {
  engine: "text" | "search";
  choice: ClaudeChoice;
  quick: boolean;
  // The system prompt the engine sends, as counted.
  systemText: string;
  // What the step reads, as its hold counts it: the count, the room countInputTokens leaves for tools,
  // and the data tools' definitions counted high.
  tokens: number;
  plan?: ToolPlan;
  // The level's output price against the engine's usual level's (chat's scale for holds).
  scale: number;
  typical: number;
};

/** The data tools Claude gets (never the free lane's web search). */
const claudeData = (data: ClientTool[]) => data.filter((x) => x.family !== "web");

/** The system prompt an AI step's engine sends for these options and tools (see streamText and streamSearch). */
export function stepSystem(step: AiStep, preferences: string, options: SystemOptions, data: ClientTool[]): string {
  const flags = toolFlags(claudeData(data));
  if (engineOf(step) === "search") return system(preferences, "search", { ...options, quick: step.mode === "quick", weather: false, ...flags });
  return system(preferences, "text", { ...options, weather: false, connect: false, ...flags });
}

/** The tool calls an AI step's hold pays for, as the chat route plans them (see toolPlan there). */
export function stepToolPlan(step: AiStep, data: ClientTool[]): ToolPlan | undefined {
  const own = claudeData(data).length > 0;
  if (engineOf(step) === "search") return researchPlan(step.mode === "quick", own);
  return own ? WEATHER_PLAN : undefined;
}

/** A level's output price against the engine's usual level's, as the chat route scales holds and typical replies. */
export function levelScale(engine: "text" | "search", model: string, tokens?: number): number {
  return claudePrice(model, tokens).output / claudePrice(defaultChoice(engine).model, tokens).output;
}

/**
 * Prices an AI step for this turn: counted by Anthropic with the client given (the automations key's,
 * so estimates and runs never use chat's limits). Throws when counting fails: a guess could be under
 * what the step reads, so a run isn't charged or sent on one.
 */
export async function priceStep(
  step: AiStep,
  history: ChatTurn[],
  preferences: string,
  options: SystemOptions,
  data: ClientTool[],
  client: Anthropic,
): Promise<StepPrice> {
  const engine = engineOf(step);
  const choice = claudeChoice(engine, step.level);
  const systemText = stepSystem(step, preferences, options, data);
  const definitions = claudeData(data).map(claudeTool);
  // What the data tools' definitions add, on top of the room countInputTokens leaves for tools.
  const dataRoom = definitions.length ? tokensAtMost(JSON.stringify(definitions)) : 0;
  const tokens = (await countInputTokens(choice.model, history, systemText, undefined, client)) + dataRoom;
  const scale = levelScale(engine, choice.model, tokens);
  return {
    engine,
    choice,
    quick: step.mode === "quick",
    systemText,
    tokens,
    plan: stepToolPlan(step, data),
    scale,
    typical: typicalCredits(engine, choice.model),
  };
}

/** A typical reply's credits on a level, as the chat route settles a stopped reply (the model that answered, after any step-down). */
export const typicalCredits = (engine: "text" | "search", model: string) => Math.max(1, Math.round((TYPICAL_CREDITS[engine] ?? 4) * levelScale(engine, model)));
