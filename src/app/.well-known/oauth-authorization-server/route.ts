import { authorizationServerMetadata, json, preflight } from "@/lib/server/connector-http.ts";

export const GET = (request: Request) => json(authorizationServerMetadata(request), 200, { "Cache-Control": "public, max-age=3600" });
export const OPTIONS = preflight;
