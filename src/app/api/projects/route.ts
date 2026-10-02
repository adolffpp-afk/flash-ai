import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { all, run, now } from "@/lib/server/db.ts";
import { randomId } from "@/lib/server/ids.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const projects = await all<{ id: string; name: string; updated_at: number }>(
    "SELECT id, name, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200",
    [user.id],
  );
  return Response.json({ projects });
}

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { name } = (await request.json().catch(() => ({}))) as { name?: string };
  const project = { id: randomId(), name: (name ?? "New project").slice(0, 80), updated_at: now() };
  await run("INSERT INTO projects (id, user_id, name, updated_at) VALUES (?, ?, ?, ?)", [
    project.id,
    user.id,
    project.name,
    project.updated_at,
  ]);
  return Response.json({ project });
}
