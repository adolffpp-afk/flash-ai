import { Resolver } from "node:dns/promises";
import { all, one, run, now } from "./db.ts";
import { isAdmin, type User } from "./auth.ts";
import { sha256 } from "./ids.ts";
import { activeSubscription } from "./subscriptions.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * Custom domains for published sites. Flash adds the domain to its own Vercel project, the owner
 * points the domain's DNS at Vercel, and src/proxy.ts sends that domain's visits to the site.
 * Needs VERCEL_API_TOKEN and VERCEL_PROJECT_ID (and VERCEL_TEAM_ID for a team project).
 */
const VERCEL_API = process.env.VERCEL_API_BASE_URL || "https://api.vercel.com";
const MAX_DOMAINS_PER_USER = 5;

export const domainsConfigured = () => Boolean(process.env.VERCEL_API_TOKEN && process.env.VERCEL_PROJECT_ID);

// Classic Vercel values, used when the API doesn't recommend others.
const FALLBACK_IP = "76.76.21.21";
const FALLBACK_CNAME = "cname.vercel-dns.com";

/** A domain name typed by a person: lowercased, without https:// or a path. Null when it isn't one. */
export function cleanDomain(input: string): string | null {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  if (d.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(d)) return null;
  // Flash's own addresses can't be claimed.
  if (/(^|\.)(flash-app\.dev|vercel\.app|vercel\.com|localhost)$/.test(d)) return null;
  return d;
}

/** Whether a domain is a subdomain (shop.example.com) rather than the bare domain (example.com). */
export function isSubdomain(domain: string): boolean {
  const twoPartEnding = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(domain);
  return domain.split(".").length > (twoPartEnding ? 3 : 2);
}

/** The part before the name people buy, as DNS settings ask for it: "shop" for shop.crumb.co.uk, "" for crumb.co.uk. */
function hostLabel(domain: string): string {
  return domain.split(".").slice(0, /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(domain) ? -3 : -2).join(".");
}

/** Custom domains are for paying plans (and Flash's admins), which keeps spammers off them. */
export async function canUseDomains(user: User): Promise<boolean> {
  return isAdmin(user) || Boolean(await activeSubscription(user.id));
}

async function vercel(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(VERCEL_API + path);
  if (process.env.VERCEL_TEAM_ID) url.searchParams.set("teamId", process.env.VERCEL_TEAM_ID);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

const project = () => encodeURIComponent(process.env.VERCEL_PROJECT_ID!);

export type DnsRecord = { type: "A" | "CNAME" | "TXT"; name: string; value: string };
// needsProof: Flash is waiting for the _flash TXT record before it adds the domain (see addDomain).
export type DomainStatus = { domain: string; connected: boolean; records: DnsRecord[]; needsProof?: boolean };

/*
 * Proof that a domain is the user's: a TXT record named _flash on the domain, holding a value
 * that is the same for all of one user's domains and different for every user. Only someone who
 * runs the domain's DNS can add it, so nobody can put their site on a domain that isn't theirs.
 */
export const ownershipValue = (userId: string) => `flash-verify=${sha256(`flash-domain:${userId}`).slice(0, 32)}`;

/** The record that proves the user owns the domain, named as the domain's DNS settings expect. */
export function ownershipRecord(domain: string, userId: string): DnsRecord {
  const label = hostLabel(domain);
  return { type: "TXT", name: label ? `_flash.${label}` : "_flash", value: ownershipValue(userId) };
}

/** Looks up a name's TXT records, each as the pieces DNS returns. */
export type TxtLookup = (name: string) => Promise<string[][]>;

const lookupTxt: TxtLookup = (name) => {
  const resolver = new Resolver({ timeout: 2500, tries: 2 });
  // A DNS server that never answers gives up within seconds, so the request doesn't hang.
  const timer = setTimeout(() => resolver.cancel(), 6000);
  return resolver.resolveTxt(name).finally(() => clearTimeout(timer));
};

/** Whether the domain's _flash TXT record holds this user's value. No record (or no answer) is no proof. */
export async function provesOwnership(domain: string, userId: string, lookup: TxtLookup = lookupTxt): Promise<boolean> {
  const records = await lookup(`_flash.${domain}`).catch(() => [] as string[][]);
  const wanted = ownershipValue(userId);
  // Some DNS providers keep the quotes people paste around the value.
  return records.some((pieces) => pieces.join("").trim().replace(/^"|"$/g, "").toLowerCase() === wanted);
}

/** Where the domain stands on Vercel, and the DNS records still to add when it isn't connected yet. */
export async function domainStatus(domain: string): Promise<DomainStatus> {
  const [info, config] = await Promise.all([
    vercel("GET", `/v9/projects/${project()}/domains/${encodeURIComponent(domain)}`),
    vercel("GET", `/v6/domains/${encodeURIComponent(domain)}/config`),
  ]);
  const records: DnsRecord[] = [];
  const verification = (info.json.verification as { type: string; domain: string; value: string }[] | undefined) ?? [];
  if (info.json.verified === false) {
    for (const v of verification) records.push({ type: "TXT", name: v.domain, value: v.value });
    // Vercel checks the TXT record when asked.
    await vercel("POST", `/v9/projects/${project()}/domains/${encodeURIComponent(domain)}/verify`).catch(() => null);
  }
  const misconfigured = config.status !== 200 || config.json.misconfigured !== false;
  if (misconfigured) {
    const top = <T,>(list: unknown) => ((list as { rank: number; value: T }[] | undefined) ?? []).sort((a, b) => a.rank - b.rank)[0]?.value;
    if (isSubdomain(domain)) {
      records.push({ type: "CNAME", name: hostLabel(domain), value: (top<string>(config.json.recommendedCNAME) || FALLBACK_CNAME).replace(/\.$/, "") });
    } else {
      records.push({ type: "A", name: "@", value: top<string[]>(config.json.recommendedIPv4)?.[0] || FALLBACK_IP });
    }
  }
  return { domain, connected: info.status === 200 && info.json.verified !== false && !misconfigured, records };
}

/** The site a custom domain shows, if any. */
export async function siteForDomain(domain: string): Promise<string | null> {
  return (await one<{ slug: string }>("SELECT site_slug AS slug FROM site_domains WHERE domain = ?", [domain]))?.slug ?? null;
}

export async function domainsForSite(slug: string): Promise<string[]> {
  return (await all<{ domain: string }>("SELECT domain FROM site_domains WHERE site_slug = ? ORDER BY created_at", [slug])).map((r) => r.domain);
}

/**
 * Connects a domain to one of the user's sites, once its DNS proves it is theirs (see
 * provesOwnership). Until then it returns the TXT record to add, and nothing is changed. Domains
 * the user already has (moving one to another of their sites) need no new proof. A domain on
 * someone else's account moves to whoever proves they run its DNS, so nobody can hold a
 * business's name hostage, and nobody can take a name that isn't theirs.
 */
export async function addDomain(
  user: User,
  slug: string,
  input: string,
  lookup: TxtLookup = lookupTxt,
  t: Translate = english,
): Promise<DomainStatus | { error: string; status: number }> {
  if (!domainsConfigured()) return { error: t("Custom domains aren't switched on yet."), status: 503 };
  if (!(await canUseDomains(user))) return { error: t("Custom domains come with a paid plan."), status: 402 };
  const domain = cleanDomain(input);
  if (!domain) return { error: t("That doesn't look like a domain. Type it like yourbakery.com or shop.yourbakery.com."), status: 400 };
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_domains WHERE user_id = ?", [user.id]);
  if (Number(count?.n ?? 0) >= MAX_DOMAINS_PER_USER) {
    return { error: t("You can connect up to {max} domains.", { max: MAX_DOMAINS_PER_USER }), status: 409 };
  }
  const taken = await one<{ user_id: string }>("SELECT user_id FROM site_domains WHERE domain = ?", [domain]);
  if (taken?.user_id !== user.id && !(await provesOwnership(domain, user.id, lookup))) {
    return { domain, connected: false, records: [ownershipRecord(domain, user.id)], needsProof: true };
  }
  const added = await vercel("POST", `/v10/projects/${project()}/domains`, { name: domain });
  const code = (added.json.error as { code?: string } | undefined)?.code;
  if (added.status >= 400 && code !== "domain_already_in_use" && code !== "domain_already_exists") {
    console.error("[flash] vercel add domain failed", added.status, added.json);
    return {
      error:
        added.status === 409
          ? t("That domain is used by another Vercel account. Remove it there first.")
          : t("Couldn't connect that domain. Please try again."),
      status: added.status === 409 ? 409 : 502,
    };
  }
  await run(
    `INSERT INTO site_domains (domain, site_slug, user_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET site_slug = excluded.site_slug, user_id = excluded.user_id, created_at = excluded.created_at`,
    [domain, slug, user.id, now()],
  );
  return domainStatus(domain);
}

/** Disconnects a domain from Flash and from Vercel. */
export async function removeDomain(domain: string): Promise<void> {
  await run("DELETE FROM site_domains WHERE domain = ?", [domain]);
  if (domainsConfigured()) {
    await vercel("DELETE", `/v9/projects/${project()}/domains/${encodeURIComponent(domain)}`).catch((err) =>
      console.error("[flash] vercel remove domain failed", err),
    );
  }
}
