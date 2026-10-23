import { bodyOf, gate, listNotices, readNotices } from "@/lib/server/automation-api.ts";

/** The Bell's automation notices in the reader's words, and { read: ids } to mark them read. */
export async function GET(request: Request) {
  const g = await gate(request, { limit: "read" });
  if (g instanceof Response) return g;
  return Response.json(await listNotices(g));
}

export async function POST(request: Request) {
  const g = await gate(request, { write: true, limit: "seen" });
  if (g instanceof Response) return g;
  return Response.json(await readNotices(g, await bodyOf(request)));
}
