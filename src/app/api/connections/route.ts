import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { connectedApps, disconnectApp } from "@/lib/server/connector.ts";

/** The apps (like Claude or ChatGPT) the user has connected to Flash. */
export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  return Response.json({ apps: await connectedApps(user.id) });
}

/** Disconnects one app: { id }. */
export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) return Response.json({ error: "Which app?" }, { status: 400 });
  await disconnectApp(user.id, id);
  return Response.json({ ok: true });
}
