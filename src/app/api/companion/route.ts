import { appUrl, getUser, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { charge, ensureMonthlyCredits, logUsage, settle, spendable } from "@/lib/server/credits.ts";
import { isVerified } from "@/lib/server/account.ts";
import { overLimit } from "@/lib/server/limits.ts";
import { pricingInfo } from "@/lib/server/pricing.ts";
import { planSummary } from "@/lib/server/subscriptions.ts";
import { engineStatus } from "@/lib/server/status.ts";
import { countryOf, recordFree, releaseFreeUser, reserveFree, reserveFreeUser } from "@/lib/server/free.ts";
import { chatsSummary, creationsSummary, spendingSummary, websitesSummary } from "@/lib/server/companion.ts";
import { claudeConfigured, type Meter } from "@/lib/engines/claude.ts";
import { freeChatConfigured, streamFreeChat } from "@/lib/engines/free.ts";
import { COMPANION_MODEL, countCompanionTokens, streamCompanion, type ToolRunner } from "@/lib/engines/companion.ts";
import { FriendlyError } from "@/lib/engines/errors.ts";
import { companionHold, finalCredits, readCostCents } from "@/lib/credits.ts";
import {
  COMPANION_PAGES,
  MAX_QUEUE,
  MAX_QUEUED_PER_ANSWER,
  cleanContext,
  cleanTurns,
  companionSystem,
  isCompanionPage,
  type CompanionEvent,
  type CompanionTurn,
} from "@/lib/companion.ts";
import { ENGINES } from "@/lib/types.ts";
import { firstName } from "@/lib/names.ts";

export const maxDuration = 60;

// About what one short answer costs, charged at least when the user stops one midway.
const TYPICAL_ANSWER_CREDITS = 2;
const WINDOW = 10 * 60_000;

/** A free model's answer, as companion events. */
async function* freeAnswer(
  turns: CompanionTurn[],
  systemPrompt: string,
  onModel: (label: string, provider: string) => void,
  country: string,
): AsyncGenerator<CompanionEvent> {
  for await (const e of streamFreeChat(turns, "", "text", reserveFree, recordFree, onModel, systemPrompt, country)) {
    if (e.type === "text") yield e;
  }
}

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  // The companion's own words (errors, what it's looking up) are in the language Flash is shown in; its answers follow its instructions.
  const t = await translatorFor(request, user.language);
  const body = (await request.json().catch(() => null)) as { messages?: unknown; context?: unknown } | null;
  const turns = cleanTurns(body?.messages);
  if (!turns) return Response.json({ error: t("The last message must be from the user.") }, { status: 400 });
  if (await overLimit(`companion:${user.id}`, 40, WINDOW)) {
    return Response.json({ error: t("That's a lot of questions at once. Try again in a few minutes.") }, { status: 429 });
  }

  await ensureMonthlyCredits(user.id);
  // The largest single balance pays (requests are charged to one account); the total is what the app shows.
  const { largest: available, total: shownCredits } = await spendable(user.id);
  const status = engineStatus();
  const pricing = pricingInfo();
  const plan = await planSummary(user.id);
  const base = appUrl(request);
  const context = cleanContext(body?.context);
  const facts = {
    // The user's own date when the app sent it, else the server's (UTC).
    today: context.today ?? new Date().toISOString().slice(0, 10),
    // What the user asked to be called (Settings > General), never an email address.
    name: firstName(user),
    // The language the companion answers in (Settings > General), "" for the one the user writes in.
    language: user.language ?? "",
    credits: shownCredits,
    plan: plan?.name ?? null,
    live: ENGINES.filter((e) => status[e]),
    costs: pricing.costs,
    models: pricing.models
      .filter((m) => m.live)
      .map((m) => ({
        label: m.label,
        engine: m.engine,
        credits: m.credits,
        blurb:
          m.id === "movie"
            ? `${m.blurb}; the price shown is for 40 seconds, longer movies cost more`
            : m.id === "post-pack" && pricing.templates["social-pack:with"]
              ? `${m.blurb}; ${pricing.templates["social-pack:with"]} credits with the video`
              : m.blurb,
      })),
    freeLane: { chats: pricing.freeLane.chats, images: pricing.freeLane.images, transcripts: pricing.freeLane.transcripts ?? 0 },
    context,
  };
  const system = companionSystem({ ...facts, tools: true });
  const inputTokens = claudeConfigured() ? await countCompanionTokens(turns, system) : 0;
  const hold = companionHold(COMPANION_MODEL, inputTokens, available);

  // Out of credits (or no Claude key): a free model answers, without tools, and it
  // counts as one of the user's free messages for today.
  let free = false;
  if (!claudeConfigured() && !freeChatConfigured()) {
    return Response.json({ error: t("The companion isn't available yet.") }, { status: 503 });
  }
  if (!claudeConfigured() || available < hold.needed) {
    if (!isVerified(user) || !freeChatConfigured()) {
      return Response.json(
        {
          error: !isVerified(user)
            ? t("The companion needs a few credits. Confirm your email to get your free credits.")
            : t("The companion needs a few credits. Get more credits to keep asking."),
          code: "out_of_credits",
        },
        { status: 402 },
      );
    }
    if (!(await reserveFreeUser(user.id, "chat"))) {
      return Response.json(
        { error: t("You've used today's free messages. They reset tomorrow, or get more credits now."), code: "out_of_credits" },
        { status: 402 },
      );
    }
    free = true;
  }
  const chargeId = free ? 0 : await charge(user.id, hold.held, "Companion");
  if (chargeId === null) {
    return Response.json({ error: t("The companion needs a few credits. Get more credits to keep asking."), code: "out_of_credits" }, { status: 402 });
  }

  const spend: number[] = [];
  const meter: Meter = (_provider, _model, cents) => spend.push(cents);
  const lined = [...(context.queue ?? [])];
  let queued = 0;
  // Set once a lookup has returned stored text (chat snippets, file names): requests added after
  // that wait for the user to press Run, so nothing written there can start paid work by itself.
  let readStored = false;
  const runTool: ToolRunner = async (name, input) => {
    switch (name) {
      case "do_next": {
        const text = typeof input.request === "string" ? input.request.trim().slice(0, 2000) : "";
        if (!text) return { result: "No request was given." };
        if (lined.includes(text)) return { result: "That request is already in Next up." };
        if (lined.length >= MAX_QUEUE) return { result: `Next up is full (${MAX_QUEUE} requests). Nothing was added; tell the user.` };
        if (++queued > MAX_QUEUED_PER_ANSWER) return { result: `Only ${MAX_QUEUED_PER_ANSWER} requests can be added at once. Nothing more was added.` };
        lined.push(text);
        if (readStored) {
          return {
            result: "Added to Next up, waiting for the user to press Run next to it (requests added after a lookup always wait).",
            action: { kind: "queue", request: text, waiting: true },
          };
        }
        return {
          result: facts.context.job
            ? "Added to Next up. It runs in the user's chat when the current job finishes."
            : "Added. It starts in the user's chat now.",
          action: { kind: "queue", request: text },
        };
      }
      case "open_page":
        if (!isCompanionPage(input.page)) return { result: "There's no such page." };
        return { result: `Opened ${COMPANION_PAGES[input.page]} for the user.`, action: { kind: "open", page: input.page } };
      case "my_websites":
        return { result: await websitesSummary(user.id, base), status: t("Checking your websites…") };
      case "my_creations":
        readStored = true;
        return { result: await creationsSummary(user.id, base), status: t("Looking at your creations…") };
      case "my_spending":
        return { result: await spendingSummary(user.id), status: t("Adding up your credits…") };
      case "search_chats": {
        const query = typeof input.query === "string" ? input.query : "";
        readStored = true;
        return { result: await chatsSummary(user.id, query), status: t("Searching your chats…") };
      }
      default:
        return { result: "That tool doesn't exist." };
    }
  };

  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    async start(controller) {
      const send = (e: CompanionEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          cancelled = true;
        }
      };
      const used = { provider: "anthropic", model: COMPANION_MODEL };
      let ok = true;
      let stopped = false;
      let failure = "";
      let written = 0;
      try {
        const events = free
          ? freeAnswer(
              turns,
              companionSystem({ ...facts, tools: false }),
              (label, provider) => {
                used.provider = provider;
                used.model = label;
              },
              countryOf(request),
            )
          : streamCompanion(turns, system, runTool, meter, hold.capCents, COMPANION_MODEL, t);
        for await (const event of events) {
          if (cancelled || request.signal.aborted) {
            stopped = true;
            break;
          }
          if (event.type === "text") written += event.delta.length;
          send(event);
        }
      } catch (err) {
        console.error("[flash] companion failed", err);
        ok = false;
        failure = err instanceof FriendlyError ? err.in(t) : t("The companion is busy right now. Please try again in a moment.");
      }
      const costCents = spend.reduce((n, c) => n + c, 0);
      const credits = free
        ? 0
        : finalCredits({
            held: hold.held,
            ok,
            stopped,
            metered: true,
            costCents,
            inputCents: readCostCents(COMPANION_MODEL, inputTokens),
            written,
            typical: TYPICAL_ANSWER_CREDITS,
          });
      if (chargeId) await settle(chargeId, credits);
      if (free && !ok) await releaseFreeUser(user.id, "chat").catch((err) => console.error("[flash] free release failed", err));
      await logUsage({ userId: user.id, engine: "companion", model: used.model, provider: used.provider, credits, costCents, ok }).catch((err) =>
        console.error("[flash] usage log failed", err),
      );
      if (!ok) send({ type: "error", message: failure + (credits ? " " + t("This used {credits} credits for the work already done.", { credits }) : "") });
      if (cancelled) return;
      if (ok) send({ type: "cost", credits, ...(free && { free: true }) });
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
