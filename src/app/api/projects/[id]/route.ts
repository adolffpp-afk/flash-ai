import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { one, run, now } from "@/lib/server/db.ts";

const MAX_MESSAGES_BYTES = 8 * 1024 * 1024;

export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await one<{ id: string; name: string; messages: string; updated_at: number }>(
    "SELECT id, name, messages, updated_at FROM projects WHERE id = ? AND user_id = ?",
    [id, user.id],
  );
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ project: { ...row, messages: JSON.parse(row.messages) } });
}

export async function PUT(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { name?: string; messages?: unknown[]; pinned?: boolean };
  const sets: string[] = [];
  const args: (string | number)[] = [];
  // Pinning alone doesn't count as an update, so the project keeps its place in time.
  if (typeof body.pinned === "boolean") {
    sets.push("pinned = ?");
    args.push(body.pinned ? 1 : 0);
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
    if (json.length > MAX_MESSAGES_BYTES) {
      return Response.json({ error: "This project is too large to save. Start a new project." }, { status: 413 });
    }
    sets.push("messages = ?");
    args.push(json);
  }
  const r = await run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, [...args, id, user.id]);
  if (!r.rowsAffected) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/projects/[id]">) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  await run("DELETE FROM projects WHERE id = ? AND user_id = ?", [id, user.id]);
  return Response.json({ ok: true });
}
