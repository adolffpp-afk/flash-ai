/*
 * Reporting what people make with Flash and show others: shared chats (/s/…), files a connected app
 * made (/f/…) and published apps (/p/…, or on the app's own domain). The Report form on shared chats
 * and the public /report page send reports to Flash's admins (src/lib/server/reports.ts); nobody
 * else sees them, the page's owner included. Published apps are their owners' own sites, so Flash
 * adds nothing to their pages: they are reported by their address on /report.
 */
import { msg } from "./i18n.ts";
import { isOwnHost } from "./site-host.ts";

export const REPORT_REASONS = [
  { id: "spam", label: msg("Spam or scam") },
  { id: "sexual", label: msg("Sexual content") },
  { id: "child", label: msg("Child safety") },
  { id: "violence", label: msg("Violence or hate") },
  { id: "harassment", label: msg("Harassment or bullying") },
  { id: "illegal", label: msg("Illegal content") },
  { id: "copyright", label: msg("Copyright or trademark") },
  { id: "privacy", label: msg("Private information") },
  { id: "other", label: msg("Something else") },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["id"];
export const isReportReason = (value: unknown): value is ReportReason => REPORT_REASONS.some((r) => r.id === value);
export const reasonLabel = (id: string) => REPORT_REASONS.find((r) => r.id === id)?.label ?? id;

// What a report may carry. The form stops at these; the server refuses more.
export const MAX_REPORT_DETAILS = 1000;
export const MAX_REPORT_ADDRESS = 500;
export const MAX_REPORT_EMAIL = 254;

export type ReportKind = "share" | "site" | "file";
// What each kind of item is called in the admin dashboard and in emails to the admins (in English, like them).
export const REPORT_KIND_NAMES: Record<ReportKind, string> = { share: "Shared chat", site: "Published app", file: "File link" };
/** What an address points at, before it's looked up: one of Flash's own pages, or a custom domain. */
export type ReportTarget = { kind: ReportKind; id: string } | { kind: "domain"; domain: string };

// Flash's own pages that show what someone made. A shared chat's pictures (/s/<id>/files/<file>)
// are the chat's, a share card (/p/<slug>/card) and the files sent to an app are the app's.
const OWN_PAGES: [RegExp, ReportKind][] = [
  [/^\/s\/([\w-]{1,64})(?:\/files\/[\w-]{1,64})?\/?$/, "share"],
  [/^\/p\/([a-z0-9-]{1,64})(?:\/card)?\/?$/, "site"],
  [/^\/api\/sites\/([a-z0-9-]{1,64})\/files\/[\w-]{1,64}$/, "site"],
  [/^\/f\/([\w-]{1,64})\/?$/, "file"],
];
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/**
 * What a pasted address points at: a page on Flash's own address (www.flash-app.dev/s/…, /p/…,
 * /f/…, with or without https://, or just the path), or any page of a custom domain, which shows
 * the one app connected to it. Null for anything else.
 */
export function reportTarget(input: string, ownHost: (host: string) => boolean = (h) => isOwnHost(h)): ReportTarget | null {
  const text = input.trim();
  if (!text || text.length > MAX_REPORT_ADDRESS) return null;
  let url: URL;
  try {
    url = text.startsWith("/") ? new URL(text, "https://www.flash-app.dev") : new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (text.startsWith("/") || ownHost(host)) {
    for (const [pattern, kind] of OWN_PAGES) {
      const id = pattern.exec(url.pathname)?.[1];
      if (id) return { kind, id };
    }
    return null;
  }
  return host.length <= 253 && DOMAIN.test(host) ? { kind: "domain", domain: host } : null;
}
