import { clearSessionCookie, endSession } from "@/lib/server/auth.ts";

export async function POST(request: Request) {
  await endSession(request);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
