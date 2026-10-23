import { startRoute } from "@/lib/server/app-routes.ts";

/* Connect Figma, or Reconnect it ({ connectionId }): see app-routes.ts. */
export const POST = startRoute("figma");
