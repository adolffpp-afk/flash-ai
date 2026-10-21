import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { all, run, now } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";

const PAGE_ID = /^[A-Za-z0-9_-]{16}$/;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const rows = await all<{ id: string; name: string; updated_at: number; pinned: number; empty: number }>(
    "SELECT id, name, updated_at, pinned, messages = '[]' AS empty FROM projects WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 200",
    [user.id],
  );
  return Response.json({ projects: rows.map((p) => ({ ...p, pinned: Boolean(p.pinned), empty: Boolean(p.empty) })) });
}

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { name, id } = (await request.json().catch(() => ({}))) as { name?: string; id?: unknown };
  // The page may name the new chat itself (16 random characters, as randomId makes), so a first message
  // shows at once instead of after this answer. An id that's taken is never reused: the insert fails.
  const project = { id: typeof id === "string" && PAGE_ID.test(id) ? id : randomId(), name: (name ?? "New project").slice(0, 80), updated_at: now() };
  const made = await run("INSERT OR IGNORE INTO projects (id, user_id, name, updated_at) VALUES (?, ?, ?, ?)", [
    project.id,
    user.id,
    project.name,
    project.updated_at,
  ]);
  if (!made.rowsAffected) return Response.json({ error: "That chat id is taken." }, { status: 409 });
  return Response.json({ project });
}
