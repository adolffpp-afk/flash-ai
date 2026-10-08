import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { hearTurn, MAX_HEAR_BYTES } from "@/lib/server/voice.ts";

export const dynamic = "force-dynamic";

/** One spoken turn of a voice conversation, from browsers that can't understand speech themselves. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  // Refused before reading the body when the browser says it's too big.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_HEAR_BYTES) {
    return Response.json({ error: "That was too long to hear in one go. Say it in shorter parts." }, { status: 413 });
  }
  const { status, body } = await hearTurn(user.id, request.headers.get("content-type") ?? "", Buffer.from(await request.arrayBuffer()));
  return Response.json(body, { status });
}
