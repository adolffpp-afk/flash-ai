import { engineStatus } from "@/lib/server/status.ts";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(engineStatus());
}
