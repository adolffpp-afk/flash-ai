import { startRoute } from "@/lib/server/app-routes.ts";

/* Connect Canva, or Reconnect it ({ connectionId }): see app-routes.ts. */
export const POST = startRoute("canva");
