/*
 * Name.com's Core API, through which Flash buys domains for its customers as a reseller, with the
 * customer as the domain's registrant (see domain-orders.ts). Name.com confirmed in writing
 * (2026-10-21) that the customer may be the Registered Name Holder, that the IP allow list is
 * optional, and that email forwarding is free on reseller accounts.
 *
 * Keys: NAMECOM_USERNAME with NAMECOM_TOKEN for the real API (api.name.com), used only when
 * NAMECOM_MODE is "live". Otherwise NAMECOM_TEST_TOKEN uses Name.com's sandbox (api.dev.name.com,
 * the username with "-test" after it), where nothing is really bought or paid.
 * Docs: https://docs.name.com/llms.txt
 */

export type NamecomMode = "live" | "sandbox";
const API: Record<NamecomMode, string> = { live: "https://api.name.com", sandbox: "https://api.dev.name.com" };

/** Which Name.com Flash buys domains with, or null when its keys aren't set. */
export function namecomMode(): NamecomMode | null {
  if (!process.env.NAMECOM_USERNAME?.trim()) return null;
  if (process.env.NAMECOM_MODE === "live") return process.env.NAMECOM_TOKEN?.trim() ? "live" : null;
  return process.env.NAMECOM_TEST_TOKEN?.trim() ? "sandbox" : null;
}

const login = (mode: NamecomMode) => {
  const user = process.env.NAMECOM_USERNAME!.trim();
  const token = (mode === "live" ? process.env.NAMECOM_TOKEN : process.env.NAMECOM_TEST_TOKEN)!.trim();
  return Buffer.from(`${mode === "sandbox" ? `${user}-test` : user}:${token}`).toString("base64");
};

/*
 * One call. A reply that never came (a timeout, a dropped connection) is status 0, kept apart from a
 * refusal: a purchase that timed out may still have gone through (see domain-orders.ts).
 */
export type NamecomReply<T> = { status: number; json: T & { message?: string; details?: string | null } };

export async function namecom<T = Record<string, unknown>>(
  mode: NamecomMode,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<NamecomReply<T>> {
  try {
    const res = await fetch(`${API[mode]}${path}`, {
      method,
      headers: { Authorization: `Basic ${login(mode)}`, ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as NamecomReply<T>["json"] };
  } catch (err) {
    console.error("[flash] name.com call failed", method, path, err);
    return { status: 0, json: {} as NamecomReply<T>["json"] };
  }
}

/** Name.com's answer for one name, from Search or Check Availability. Prices are US dollars. */
export type NameResult = {
  domainName: string;
  sld: string;
  tld: string;
  purchasable: boolean;
  premium?: boolean;
  purchasePrice?: number;
  purchaseType?: string;
  renewalPrice?: number;
  reason?: string;
};

/** Names close to a keyword in these endings, with their prices. Null when Name.com didn't answer. */
export async function searchNames(mode: NamecomMode, keyword: string, endings: string[]): Promise<NameResult[] | null> {
  const r = await namecom<{ results?: NameResult[] }>(mode, "POST", "/core/v1/domains:search", {
    keyword,
    tldFilter: endings,
    purchaseType: "registration",
    timeout: 5000,
  });
  return r.status === 200 ? (r.json.results ?? []) : null;
}

/** Whether names can be bought now, and at what price: asked again right before every purchase. */
export async function checkNames(mode: NamecomMode, names: string[]): Promise<NameResult[] | null> {
  const r = await namecom<{ results?: NameResult[] }>(mode, "POST", "/core/v1/domains:checkAvailability", {
    domainNames: names,
    purchaseType: "registration",
  });
  return r.status === 200 ? (r.json.results ?? []) : null;
}

/** A registrant's details as Name.com takes them: phone in E.164 (+15145550100), country in ISO (CA). */
export type Contact = {
  firstName: string;
  lastName: string;
  companyName?: string | null;
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  email: string;
  phone: string;
};

export type NamecomDomain = {
  domainName: string;
  createDate: string;
  expireDate: string;
  autorenewEnabled: boolean;
  locked: boolean;
  privacyEnabled: boolean;
  nameservers: string[];
  renewalPrice?: number;
  contacts?: { registrant?: Contact & { isVerified?: boolean; verificationId?: number | null } };
};

/*
 * Buys a domain for 1 year with the customer on all four contacts, privacy on, locked, and
 * Name.com's own auto-renew off (Flash charges the customer first, then renews). The order's id is
 * the idempotency key: a retry within the hour gets the first answer, never a second purchase.
 * purchasePrice is always sent, so Name.com refuses rather than charge more than Flash quoted.
 */
export function buyDomain(mode: NamecomMode, domain: string, priceDollars: number, contact: Contact, key: string) {
  return namecom<{ domain?: NamecomDomain; order?: number; totalPaid?: number }>(
    mode,
    "POST",
    "/core/v1/domains",
    {
      domain: {
        domainName: domain,
        privacyEnabled: true,
        autorenewEnabled: false,
        locked: true,
        contacts: { registrant: contact, admin: contact, tech: contact, billing: contact },
      },
      purchasePrice: priceDollars,
      purchaseType: "registration",
      years: 1,
    },
    { "X-Idempotency-Key": key },
    // Registries can be slow; a reply that takes longer than this is checked again later.
    45_000,
  );
}

/*
 * Renews a domain for 1 year, at purchasePrice or not at all, with the order's id as the
 * idempotency key, as buyDomain does.
 */
export function renewDomain(mode: NamecomMode, domain: string, priceDollars: number, key: string) {
  return namecom<{ domain?: NamecomDomain; order?: number; totalPaid?: number }>(
    mode,
    "POST",
    `/core/v1/domains/${encodeURIComponent(domain)}:renew`,
    { purchasePrice: priceDollars, years: 1 },
    { "X-Idempotency-Key": key },
    45_000,
  );
}

/** Sends the registrant Name.com's email to confirm their details again. Name.com allows it only so often (429). */
export async function resendVerification(mode: NamecomMode, verificationId: number): Promise<number> {
  return (await namecom(mode, "POST", `/core/v1/contacts/verify/${verificationId}:resend`, {})).status;
}

/** A domain in Flash's Name.com account, or null when it isn't there (404). Throws when Name.com didn't say. */
export async function getDomain(mode: NamecomMode, domain: string): Promise<NamecomDomain | null> {
  const r = await namecom<NamecomDomain>(mode, "GET", `/core/v1/domains/${encodeURIComponent(domain)}`);
  if (r.status === 200) return r.json;
  if (r.status === 404) return null;
  throw new Error(`Name.com answered ${r.status} for ${domain}`);
}

export type NamecomRecord = { id: number; host?: string; type: string; answer: string; ttl?: number };

/*
 * Points a domain Flash bought at Flash's Vercel project, on Name.com's DNS: the A record for the
 * bare name, the CNAME for www, and the _flash TXT that shows the domain is its owner's (see
 * ownershipRecord in domains.ts). Any address record already on those names (Name.com's parking
 * page) is taken off first. Returns false when a record couldn't be written, so it is tried again.
 */
export async function pointAtFlash(mode: NamecomMode, domain: string, ip: string, cname: string, proof: string): Promise<boolean> {
  const path = `/core/v1/domains/${encodeURIComponent(domain)}/records`;
  const listed = await namecom<{ records?: NamecomRecord[] }>(mode, "GET", `${path}?perPage=1000`);
  if (listed.status !== 200) return false;
  const existing = listed.json.records ?? [];
  const wanted = [
    { host: "", type: "A", answer: ip },
    { host: "www", type: "CNAME", answer: cname },
    { host: "_flash", type: "TXT", answer: proof },
  ];
  // The bare name's records may come back with no host, "" or "@".
  const hostOf = (r: NamecomRecord) => (r.host === "@" ? "" : (r.host ?? ""));
  const same = (r: NamecomRecord, w: (typeof wanted)[number]) => hostOf(r) === w.host && r.type === w.type && r.answer.replace(/\.$/, "") === w.answer;
  for (const r of existing) {
    const host = hostOf(r);
    const inTheWay = (host === "" && ["A", "AAAA", "ANAME", "CNAME"].includes(r.type)) || (host === "www" && ["A", "AAAA", "ANAME", "CNAME"].includes(r.type));
    if (inTheWay && !wanted.some((w) => same(r, w))) {
      const gone = await namecom(mode, "DELETE", `${path}/${r.id}`);
      if (gone.status !== 200 && gone.status !== 204 && gone.status !== 404) return false;
    }
  }
  for (const w of wanted) {
    if (existing.some((r) => same(r, w))) continue;
    const made = await namecom(mode, "POST", path, { ...w, ttl: 300 });
    if (made.status !== 200) {
      console.error("[flash] name.com record failed", domain, w.type, made.status, made.json.message);
      return false;
    }
  }
  return true;
}

/** Flash's Name.com account credit in US cents, or null when Name.com didn't answer. */
export async function namecomBalanceCents(mode: NamecomMode): Promise<number | null> {
  const r = await namecom<{ balance?: number }>(mode, "GET", "/core/v1/accountinfo/balance");
  return r.status === 200 && typeof r.json.balance === "number" ? Math.round(r.json.balance * 100) : null;
}
