import { getUser, unauthorized } from "@/lib/server/auth.ts";
import { isVerified } from "@/lib/server/account.ts";
import { translatorFor } from "@/lib/server/i18n.ts";
import { hearTurn, MAX_HEAR_BYTES, tooLongToHear } from "@/lib/server/voice.ts";

export const dynamic = "force-dynamic";

/** One spoken turn of a voice conversation, from browsers that can't understand speech themselves. */
export async function POST(request: Request) {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  // Refused before reading the body when the browser says it's too big.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_HEAR_BYTES) {
    const { status, body } = tooLongToHear(t);
    return Response.json(body, { status });
  }
  const { status, body } = await hearTurn(
    user.id,
    request.headers.get("content-type") ?? "",
    Buffer.from(await request.arrayBuffer()),
    { verified: isVerified(user) },
    t,
  );
  return Response.json(body, { status });
}
