// Flash's own addresses; any other host is a custom domain showing a published site.
const OWN_HOST = /(^|\.)flash-app\.dev$|\.vercel\.app$|^localhost$|^127\.0\.0\.1$|^\[::1\]$/;
// What a site on its own domain may call: its flashDB data (shared and each person's own), its
// form inbox, its shop, its own assistant, the files sent to it, and signing visitors in and out.
const SITE_API = /^\/api\/sites\/[\w-]+\/(data|mine|inbox|shop|auth|ai|files(\/[\w-]+)?)$/;

export type HostRoute = { pass: true } | { rewrite: string } | { redirect: "/" } | { notFound: true };

/** What to do with a request, by the host it came to (see src/proxy.ts). */
/** Whether a host is one of Flash's own addresses, rather than a site's custom domain. */
export const isOwnHost = (host: string, appHost = process.env.FLASH_APP_URL ? new URL(process.env.FLASH_APP_URL).hostname : "") =>
  !host || host === appHost || OWN_HOST.test(host);

export function routeHost(hostHeader: string, path: string, method: string, appHost = ""): HostRoute {
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (isOwnHost(host, appHost)) return { pass: true };
  if (SITE_API.test(path)) return { pass: true };
  if (path === "/") return { rewrite: `/d/${encodeURIComponent(host)}` };
  // A site is one page, so other paths go home; Flash's own pages aren't reachable from here.
  if (method === "GET" && path !== "/favicon.ico") return { redirect: "/" };
  return { notFound: true };
}
