import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one, run, now } from "@/lib/server/db.ts";
import { cleanInstructions } from "@/lib/project-instructions.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { PROJECT_TOO_LARGE, projectTooLarge } from "@/lib/project-size.ts";
import { unfinished } from "@/lib/server/turns.ts";

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await one<{ id: string; name: string; messages: string; updated_at: number; instructions: string }>(
    "SELECT id, name, messages, updated_at, instructions FROM projects WHERE id = ? AND user_id = ?",
    [id, user.id],
  );
  const t = await translatorFor(request, user.language);
  if (!row) return Response.json({ error: t("Not found") }, { status: 404 });
  // A reply the server is still finishing shows as pending; one whose server never finished it doesn't.
  const messages = unfinished(JSON.parse(row.messages), t("Flash couldn't finish this answer. Please try again."));
  return Response.json({ project: { ...row, messages } });
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
  };
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
  if (body.name !== undefined || body.messages !== undefined || !sets.length) {
    sets.push("updated_at = ?");
    args.push(now());
  }
  if (typeof body.name === "string" && body.name.trim()) {
    sets.push("name = ?");
    args.push(body.name.trim().slice(0, 80));
  }
  if (Array.isArray(body.messages)) {
    const json = JSON.stringify(body.messages);
    if (projectTooLarge(json)) return Response.json({ error: t(PROJECT_TOO_LARGE) }, { status: 413 });
    // Raised by every write of messages, so the chat route's own saving never overwrites this (see turns.ts).
    sets.push("messages = ?", "version = version + 1");
    args.push(json);
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
