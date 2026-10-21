import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one, run, now } from "@/lib/server/db.ts";
import { cleanInstructions } from "@/lib/project-instructions.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { PROJECT_TOO_LARGE, projectTooLarge } from "@/lib/project-size.ts";
import { saveCopy, unfinished } from "@/lib/server/turns.ts";
import type { UIMessage } from "@/lib/store.ts";
import { ASSISTANTS_ON } from "@/lib/assistants.ts";
import { assistantSummary, loadAssistantFor } from "@/lib/server/assistants.ts";

type ProjectRow = { id: string; name: string; messages: string; updated_at: number; instructions: string };

/**
 * A chat's assistant as the chat shows it: its summary while the user may use it, or gone with why
 * (see loadAssistantFor), so the page can offer to continue without it. Nothing for a chat without one.
 */
async function chatAssistant(userId: string, assistantId: string) {
  if (!assistantId) return {};
  const access = await loadAssistantFor(userId, assistantId);
  return { assistant: "gone" in access ? { gone: true, reason: access.gone } : await assistantSummary(access.a, access.mine) };
}

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  // While assistants are off, the chat is read as it always was, and its assistant isn't looked at.
  const found = ASSISTANTS_ON
    ? await one<ProjectRow & { assistant_id: string }>("SELECT id, name, messages, updated_at, instructions, assistant_id FROM projects WHERE id = ? AND user_id = ?", [id, user.id])
    : await one<ProjectRow>("SELECT id, name, messages, updated_at, instructions FROM projects WHERE id = ? AND user_id = ?", [id, user.id]);
  const t = await translatorFor(request, user.language);
  if (!found) return Response.json({ error: t("Not found") }, { status: 404 });
  const { assistant_id: assistantId = "", ...row } = found as ProjectRow & { assistant_id?: string };
  // A reply the server is still finishing shows as pending; one whose server never finished it doesn't.
  const messages = unfinished(JSON.parse(row.messages), t("Flash couldn't finish this answer. Please try again."));
  return Response.json({ project: { ...row, messages, ...(ASSISTANTS_ON ? await chatAssistant(user.id, assistantId) : {}) } });
}

export async function PUT(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    messages?: unknown[];
    pinned?: boolean;
    instructions?: string;
    assistantId?: unknown;
  };
  // "Continue without it": a chat's assistant can only be taken off it, never put on (a chat is
  // started with one by POST /api/assistants/[id]/chats). Ignored while assistants are off.
  const dropAssistant = ASSISTANTS_ON && body.assistantId !== undefined;
  if (dropAssistant && body.assistantId !== "") return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 400 });
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : undefined;
  if (Array.isArray(body.messages)) {
    const json = JSON.stringify(body.messages);
    if (projectTooLarge(json)) return Response.json({ error: t(PROJECT_TOO_LARGE) }, { status: 413 });
    const incoming = body.messages.filter((m): m is UIMessage => Boolean(m) && typeof m === "object");
    // Written only if nothing saved the chat since it was read, and never over a reply a request is
    // still working on: that request saves it (see saveCopy in turns.ts). The chat as saved, with
    // those replies, must fit too.
    const saved = await saveCopy(user.id, id, incoming, name);
    if (saved === "too large") return Response.json({ error: t(PROJECT_TOO_LARGE) }, { status: 413 });
    if (saved === "not saved") {
      const found = await one("SELECT 1 FROM projects WHERE id = ? AND user_id = ?", [id, user.id]);
      return found
        ? Response.json({ error: t("Couldn't save your project.") }, { status: 409 })
        : Response.json({ error: t("Not found") }, { status: 404 });
    }
    if (typeof body.pinned !== "boolean" && typeof body.instructions !== "string" && !dropAssistant) return Response.json({ ok: true });
  }
  const sets: string[] = [];
  const args: (string | number)[] = [];
  // Pinning or changing instructions alone doesn't count as an update, so the project keeps its place in time.
  if (typeof body.pinned === "boolean") {
    sets.push("pinned = ?");
    args.push(body.pinned ? 1 : 0);
  }
  if (typeof body.instructions === "string") {
    sets.push("instructions = ?");
    args.push(cleanInstructions(body.instructions));
  }
  // Nor does taking its assistant off. One that isn't the user's own, or was deleted (whose it was
  // can't be told), is remembered: the replies it wrote stay in the chat, so the user's own things
  // stay out of it as they did (assistant_theirs, see the chat route). Both read the row as it was.
  if (dropAssistant) {
    sets.push(
      "assistant_theirs = CASE WHEN assistant_theirs = 1 OR (assistant_id != '' AND NOT EXISTS (SELECT 1 FROM assistants a WHERE a.id = projects.assistant_id AND a.user_id = projects.user_id)) THEN 1 ELSE 0 END",
      "assistant_id = ''",
    );
  }
  // Messages (with the name) were saved above.
  if (!Array.isArray(body.messages)) {
    if (body.name !== undefined || !sets.length) {
      sets.push("updated_at = ?");
      args.push(now());
    }
    if (name) {
      sets.push("name = ?");
      args.push(name);
    }
  }
  const r = await run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [...args, id, user.id]);
  if (!r.rowsAffected) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  await run("DELETE FROM projects WHERE id = ? AND user_id = ?", [id, user.id]);
  return Response.json({ ok: true });
}
