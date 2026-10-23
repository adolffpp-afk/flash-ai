import { callbackRoute } from "@/lib/server/app-routes.ts";

/* Canva's redirect URL, registered in Flash's app there: see app-routes.ts. */
export const GET = callbackRoute("canva");
