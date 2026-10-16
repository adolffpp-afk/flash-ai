import { assetLinks } from "@/lib/android-app";

export const dynamic = "force-static";

export const GET = () => Response.json(assetLinks(), { headers: { "Cache-Control": "public, max-age=3600" } });
