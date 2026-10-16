import { appUrl, getUser, isAdmin, unauthorized } from "@/lib/server/auth.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { connectorsReady } from "@/lib/server/secret-box.ts";
import { githubReady } from "@/lib/server/github.ts";
import { googleReady } from "@/lib/server/google.ts";
import { ConnectError, addConnection, listConnections, previewServer, problemText, removeConnection } from "@/lib/server/connections.ts";
import { approvalAllowed } from "@/lib/server/pending-actions.ts";

/*
 * The user's connected accounts (Settings > Connectors): GET lists them (never a secret, only its
 * last 4 characters), POST looks at a server's tools ("preview", or how it signs in when it asks for
 * that) or adds an account with a key ("add"; signing in is /api/connect/mcp/start, GitHub's
 * /api/connect/github/start and Google Drive's /api/connect/google/start), DELETE removes one (an account that signed in is signed out at its
 * server first). Both change what is stored, so like an approval they are taken only with Flash's
 * exact Origin (S-3). Until CONNECTOR_KEYS
 * is set nothing can be added (503), and the owner is told why; an account whose email isn't
 * confirmed can't look at or add one either (403, see confirmedOnly). github says whether GitHub can
 * be connected: until the GitHub App is set up, it isn't offered and a GitHub account isn't listed;
 * google says the same of Google Drive (Flash's Google Cloud project, see google.ts). Google Drive's
 * picked files are /api/connect/google/files.
 */

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const ready = connectorsReady();
  return Response.json({ ready, owner: isAdmin(user), github: githubReady(), google: googleReady(), connections: ready ? await listConnections(user.id) : [] });
}

type AddBody = { action?: unknown; provider?: unknown; url?: unknown; token?: unknown; label?: unknown; pins?: unknown };

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!approvalAllowed(request, [new URL(appUrl(request)).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  }
  if (!connectorsReady()) return Response.json({ error: t("Connectors aren't set up yet.") }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as AddBody;
  const input = {
    provider: text(body.provider, 40) ?? "",
    url: text(body.url, 2000),
    token: text(body.token, 4000),
    label: text(body.label, 60),
  };
  const pins =
    body.pins && typeof body.pins === "object" && !Array.isArray(body.pins)
      ? Object.fromEntries(Object.entries(body.pins as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string").slice(0, 100))
      : undefined;
  try {
    if (body.action === "preview") return Response.json(await previewServer(user.id, input, appUrl(request)));
    if (body.action === "add") return Response.json({ connection: await addConnection(user.id, { ...input, pins }) });
    return Response.json({ error: t("Unknown action.") }, { status: 400 });
  } catch (err) {
    if (err instanceof ConnectError) {
      const status = err.code === "limit" ? 429 : err.code === "too_many" || err.code === "changed" ? 409 : err.code === "unverified" ? 403 : 400;
      return Response.json({ error: problemText(err.code, t), code: err.code }, { status });
    }
    console.error("[flash] adding a connector failed", err instanceof Error ? err.name : "error");
    return Response.json({ error: t("Something went wrong. Please try again.") }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  if (!approvalAllowed(request, [new URL(appUrl(request)).origin, new URL(request.url).origin])) {
    return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  }
  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (typeof id !== "string" || !(await removeConnection(user.id, id))) return Response.json({ error: t("Not found") }, { status: 404 });
  return Response.json({ ok: true });
}
