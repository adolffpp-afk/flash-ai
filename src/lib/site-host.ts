// Flash's own addresses; any other host is a custom domain showing a published site.
const OWN_HOST = /(^|\.)flash-app\.dev$|\.vercel\.app$|^localhost$|^127\.0\.0\.1$|^\[::1\]$/;
// What a site on its own domain may call: its flashDB data (shared and each person's own), its
// form inbox, its shop, its own assistant, the files sent to it, signing visitors in and out, and
// the steps it reports (flashDB.track).
const SITE_API = /^\/api\/sites\/([\w-]+)\/(data|mine|inbox|shop|auth|ai|files(\/[\w-]+)?|track)$/;

// siteApi: a site API call on a custom domain, which goes through only for the site connected to
// that domain (checked in src/proxy.ts), so another app's files can't be shown under it.
export type HostRoute = { pass: true } | { siteApi: string } | { rewrite: string } | { redirect: "/" } | { notFound: true };

/**
 * The header on every request Flash itself sends to an address a user gave (see safe-fetch.ts). A
 * request that carries it is Flash calling itself, through a host its own list doesn't know (another
 * deployment's address, an alias): it is refused, whatever the host.
 */
export const OUTBOUND_HEADER = "x-flash-outbound";

/** What to do with a request, by the host it came to (see src/proxy.ts). */
/** Whether a host is one of Flash's own addresses, rather than a site's custom domain. */
export const isOwnHost = (host: string, appHost = process.env.FLASH_APP_URL ? new URL(process.env.FLASH_APP_URL).hostname : "") =>
  !host || host === appHost || OWN_HOST.test(host);

export function routeHost(hostHeader: string, path: string, method: string, appHost = "", outbound = false): HostRoute {
  if (outbound) return { notFound: true };
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (isOwnHost(host, appHost)) return { pass: true };
  const api = SITE_API.exec(path);
  if (api) return { siteApi: api[1] };
  if (path === "/") return { rewrite: `/d/${encodeURIComponent(host)}` };
  // A site is one page, so other paths go home; Flash's own pages aren't reachable from here.
  if (method === "GET" && path !== "/favicon.ico") return { redirect: "/" };
  return { notFound: true };
}
