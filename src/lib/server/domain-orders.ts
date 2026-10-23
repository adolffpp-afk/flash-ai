import { randomUUID } from "node:crypto";
import { all, one, run, now } from "./db.ts";
import { isAdmin, type User } from "./auth.ts";
import { afterResponse } from "./after-response.ts";
import { sendEmail } from "./email.ts";
import { ownsSite } from "./inbox.ts";
import { connectBoughtDomain, domainsConfigured, ownershipValue } from "./domains.ts";
import { buyDomain, checkNames, getDomain, namecomMode, pointAtFlash, searchNames, type Contact, type NameResult, type NamecomDomain, type NamecomMode } from "./namecom.ts";
import { cancelPayment, capturePayment, createDomainCheckout, getCheckout, getPayment, paymentsEnabled } from "./stripe.ts";
import { DOMAIN_ENDINGS, MAX_NAMECOM_CENTS, REGISTRANT_COUNTRIES, SANCTIONED_COUNTRIES, domainPriceCents, searchKeyword, sellableName } from "../domain-price.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * Buying a domain inside Flash, through Name.com's reseller API (see namecom.ts), with the customer
 * as its registrant. No step can leave Flash paying for a domain it wasn't paid for:
 *
 *   1. Checkout: a fresh price from Name.com, Flash's price on top (domain-price.ts), and a Stripe
 *      Checkout that only holds the card (startDomainOrder).
 *   2. The webhook says the card is held (domainCheckoutCompleted): Flash checks the hold and
 *      Stripe's fraud check, asks Name.com's price again, and buys with the order's id as the
 *      idempotency key and the quoted price as purchasePrice (finishOrder).
 *   3. Bought: the hold is charged, the domain is kept as the customer's, then its DNS is written on
 *      Name.com and it is connected to their site. A clear refusal lets the hold go. No sure answer
 *      (a timeout, Name.com down) keeps the hold: the order is "unknown" and is asked again with
 *      the same key within the hour (Name.com's replay window), then by looking the domain up.
 *
 * Each step moves an order on with one UPDATE … WHERE status = ?, so a webhook sent twice, a page
 * asking for progress and the order finisher (/api/cron/domain-orders) never buy twice.
 *
 * Who can buy: only Flash's admins for now (FLASH_DOMAIN_SALES "admins" with NAMECOM_MODE "live";
 * Name.com's sandbox for admins whenever its test token is set, with no payment). Paying customers
 * come once the Terms have their domain section.
 */

export type OrderStatus = "quoted" | "authorized" | "buying" | "unknown" | "done" | "failed" | "cancelled" | "expired";

export type DomainOrder = {
  id: string;
  user_id: string;
  domain: string;
  kind: string;
  years: number;
  cost_cents: number;
  price_cents: number;
  renewal_cost_cents: number;
  renewal_price_cents: number;
  contact: string;
  for_site: string | null;
  mode: NamecomMode;
  checkout_session: string | null;
  payment_intent: string | null;
  namecom_order: string | null;
  total_paid_cents: number;
  status: OrderStatus;
  error: string;
  buy_started_at: number;
  setup_at: number;
  admin_told_at: number;
  created_at: number;
  updated_at: number;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Name.com keeps an idempotency key's answer for 1 hour: a retry stays safe well inside it.
const REPLAY_WINDOW = 50 * MINUTE;
// A purchase that has been "buying" this long was cut off (the server stopped): asked again.
const STUCK_BUYING = 5 * MINUTE;
const MAX_OWNED = 5;
// Holds still open after this long are told to the admins.
const TELL_ADMIN_AFTER = 3 * DAY;

/** Which Name.com this user buys domains with, or null when they can't buy one (yet). */
export function domainSalesFor(user: Pick<User, "email" | "verified_at">): NamecomMode | null {
  const mode = namecomMode();
  if (!mode || !isAdmin(user)) return null;
  if (mode === "sandbox") return mode;
  const sales = process.env.FLASH_DOMAIN_SALES ?? "off";
  return (sales === "admins" || sales === "paid") && paymentsEnabled() && domainsConfigured() ? mode : null;
}

export type DomainOffer = { domain: string; priceCents: number; renewalPriceCents: number };

/** Flash's offer for one of Name.com's answers, or null when Flash doesn't sell it. */
export function offerFor(r: NameResult): DomainOffer | null {
  const domain = r.domainName?.toLowerCase();
  if (!domain || !r.purchasable || r.premium || (r.purchaseType && r.purchaseType !== "registration")) return null;
  if (typeof r.purchasePrice !== "number" || !Number.isFinite(r.purchasePrice) || r.purchasePrice <= 0) return null;
  const cost = Math.round(r.purchasePrice * 100);
  const renewal = typeof r.renewalPrice === "number" && r.renewalPrice > 0 ? Math.round(r.renewalPrice * 100) : cost;
  if (cost > MAX_NAMECOM_CENTS || renewal > MAX_NAMECOM_CENTS || !sellableName(domain)) return null;
  return { domain, priceCents: domainPriceCents(cost), renewalPriceCents: domainPriceCents(renewal) };
}

/** Up to 8 names Flash can sell for what was typed, the exact name first, then by ending. Null when Name.com didn't answer. */
export async function searchDomains(mode: NamecomMode, input: string): Promise<{ keyword: string; offers: DomainOffer[] } | null> {
  const keyword = searchKeyword(input);
  if (keyword.length < 1) return { keyword, offers: [] };
  const results = await searchNames(mode, keyword, DOMAIN_ENDINGS);
  if (!results) return null;
  const rank = (d: string) => {
    const [name, ending] = d.split(".");
    return (name === keyword ? 0 : 100) + DOMAIN_ENDINGS.indexOf(ending);
  };
  const offers = results
    .map(offerFor)
    .filter((o): o is DomainOffer => o !== null)
    .sort((a, b) => rank(a.domain) - rank(b.domain));
  return { keyword, offers: [...new Map(offers.map((o) => [o.domain, o])).values()].slice(0, 8) };
}

const field = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "");

/** The registrant's details as typed, cleaned for Name.com, or what is wrong with them. */
export function cleanContact(input: unknown, t: Translate = english): { contact: Contact } | { error: string } {
  const c = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const contact: Contact = {
    firstName: field(c.firstName, 60),
    lastName: field(c.lastName, 60),
    companyName: field(c.companyName, 100) || null,
    address1: field(c.address1, 100),
    address2: field(c.address2, 100) || null,
    city: field(c.city, 60),
    state: field(c.state, 60),
    zip: field(c.zip, 20),
    country: field(c.country, 2).toUpperCase(),
    email: field(c.email, 200).toLowerCase(),
    phone: field(c.phone, 30).replace(/[\s().-]/g, ""),
  };
  if (![contact.firstName, contact.lastName, contact.address1, contact.city, contact.state, contact.zip].every(Boolean)) {
    return { error: t("Please fill in your name and full address.") };
  }
  if (!/^[A-Z]{2}$/.test(contact.country) || (!REGISTRANT_COUNTRIES.includes(contact.country) && !SANCTIONED_COUNTRIES.includes(contact.country))) return { error: t("Please pick your country.") };
  if (SANCTIONED_COUNTRIES.includes(contact.country)) return { error: t("Domains can't be registered to that country.") };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return { error: t("Please type a working email address.") };
  if (!/^\+[1-9]\d{7,14}$/.test(contact.phone)) return { error: t("Type your phone number with its country code, like +1 514 555 0100.") };
  return { contact };
}

/** What is left of the registrant's details once an order ends: their name, email and country. */
const keptContact = (json: string) => {
  try {
    const c = JSON.parse(json) as Contact;
    return JSON.stringify({ firstName: c.firstName, lastName: c.lastName, email: c.email, country: c.country });
  } catch {
    return "";
  }
};

const order = (id: string) => one<DomainOrder>("SELECT * FROM domain_orders WHERE id = ?", [id]);

/** Moves an order from one status to another; false when it wasn't in that status (someone else moved it). */
async function move(id: string, from: OrderStatus | OrderStatus[], to: OrderStatus, set: Record<string, string | number | null> = {}): Promise<boolean> {
  const froms = Array.isArray(from) ? from : [from];
  const cols = Object.keys(set);
  const r = await run(
    `UPDATE domain_orders SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND status IN (${froms.map(() => "?").join(", ")})`,
    [to, now(), ...cols.map((c) => set[c]), id, ...froms],
  );
  return r.rowsAffected === 1;
}

/** Today's spend on Name.com (UTC), in its cents, with the orders that may still be bought. */
async function spentToday(): Promise<number> {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const r = await one<{ n: number }>(
    "SELECT COALESCE(SUM(cost_cents), 0) AS n FROM domain_orders WHERE mode = 'live' AND created_at >= ? AND status IN ('authorized', 'buying', 'unknown', 'done')",
    [day.getTime()],
  );
  return Number(r?.n ?? 0);
}

const dailyCapCents = () => {
  const n = Number(process.env.FLASH_DOMAIN_DAILY_CAP_USD);
  return Math.round((Number.isFinite(n) && n >= 0 && process.env.FLASH_DOMAIN_DAILY_CAP_USD?.trim() ? n : 100) * 100);
};

export type StartResult = { url: string; order: string } | { order: string } | { error: string; status: number };

/**
 * Starts buying a domain for one of the user's sites: checks the name, the details and the limits,
 * asks Name.com's price again, keeps the order, and opens Stripe Checkout to hold the card. In
 * Name.com's sandbox there's nothing to pay: the order goes straight to buying.
 */
export async function startDomainOrder(
  user: User,
  mode: NamecomMode,
  input: { domain?: unknown; siteSlug?: unknown; contact?: unknown; accepted?: unknown },
  origin: string,
  t: Translate = english,
): Promise<StartResult> {
  const domain = String(input.domain ?? "").trim().toLowerCase();
  if (!sellableName(domain)) return { error: t("Flash can't sell that name. Try another one."), status: 400 };
  const slug = String(input.siteSlug ?? "");
  if (!slug || !(await ownsSite(user.id, slug))) return { error: t("Not found"), status: 404 };
  if (input.accepted !== true) return { error: t("Please tick the box to accept the domain terms."), status: 400 };
  const cleaned = cleanContact(input.contact, t);
  if ("error" in cleaned) return { error: cleaned.error, status: 400 };

  const owned = await one<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM owned_domains WHERE user_id = ? AND status = 'active')
          + (SELECT COUNT(*) FROM domain_orders WHERE user_id = ? AND status IN ('authorized', 'buying', 'unknown')) AS n`,
    [user.id, user.id],
  );
  if (Number(owned?.n ?? 0) >= MAX_OWNED) return { error: t("You can have up to {max} domains from Flash.", { max: MAX_OWNED }), status: 409 };
  const open = await one<{ id: string }>(
    `SELECT id FROM domain_orders WHERE domain = ? AND status IN ('authorized', 'buying', 'unknown')
     UNION ALL SELECT domain FROM owned_domains WHERE domain = ? AND status = 'active' AND mode = ?`,
    [domain, domain, mode],
  );
  if (open) return { error: t("That name is being bought right now, or is already taken in Flash."), status: 409 };

  const fresh = (await checkNames(mode, [domain]))?.find((r) => r.domainName?.toLowerCase() === domain);
  if (!fresh) return { error: t("Couldn't check that name right now. Please try again."), status: 502 };
  const offer = offerFor(fresh);
  if (!offer) return { error: t("That name was just taken, or can't be sold in Flash. Try another one."), status: 409 };
  const cost = Math.round(fresh.purchasePrice! * 100);
  if (mode === "live" && (await spentToday()) + cost > dailyCapCents()) {
    return { error: t("Flash has sold all the domains it can today. Please try again tomorrow."), status: 429 };
  }

  const id = randomUUID();
  const at = now();
  await run(
    `INSERT INTO domain_orders (id, user_id, domain, kind, years, cost_cents, price_cents, renewal_cost_cents, renewal_price_cents, contact,
       for_site, mode, status, created_at, updated_at)
     VALUES (?, ?, ?, 'register', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, user.id, domain, cost, offer.priceCents,
      typeof fresh.renewalPrice === "number" ? Math.round(fresh.renewalPrice * 100) : cost, offer.renewalPriceCents,
      JSON.stringify(cleaned.contact), slug, mode, mode === "sandbox" ? "authorized" : "quoted", at, at,
    ],
  );
  if (mode === "sandbox") {
    void afterResponse(() => finishOrder(id)).catch((err) => console.error("[flash] domain order failed", id, err));
    return { order: id };
  }
  try {
    const checkout = await createDomainCheckout({ id, domain, priceCents: offer.priceCents }, user, origin);
    await run("UPDATE domain_orders SET checkout_session = ?, updated_at = ? WHERE id = ?", [checkout.id, now(), id]);
    return { url: checkout.url, order: id };
  } catch (err) {
    console.error("[flash] domain checkout failed", id, err);
    await move(id, "quoted", "failed", { error: "checkout" });
    return { error: t("Couldn't open checkout. Please try again."), status: 502 };
  }
}

/** The webhook's checkout.session.completed for a domain: the card is held, so the purchase can go on. */
export async function domainCheckoutCompleted(session: string, orderId: string, paymentIntent: string | null | undefined): Promise<void> {
  const o = await order(orderId);
  if (!o || o.checkout_session !== session || !paymentIntent) return;
  await move(orderId, "quoted", "authorized", { payment_intent: paymentIntent });
  await afterResponse(() => finishOrder(orderId)).catch((err) => console.error("[flash] domain order failed", orderId, err));
}

/**
 * Lets the customer's hold go (nothing is charged) and ends the order with why. The order ends even
 * when Stripe couldn't be reached, so it is never bought later: the hold then runs out on its own
 * within days, and the admins are told.
 */
async function release(o: DomainOrder, from: OrderStatus | OrderStatus[], to: "failed" | "cancelled", why: string): Promise<void> {
  let letGo = true;
  if (o.mode === "live" && o.payment_intent) {
    try {
      await cancelPayment(o.payment_intent);
    } catch (err) {
      // Already let go by an earlier run: the payment's own status tells.
      const p = await getPayment(o.payment_intent).catch(() => null);
      letGo = p?.status === "canceled";
      if (!letGo) console.error("[flash] couldn't let the domain hold go", o.id, err);
    }
  }
  const ended = await move(o.id, from, to, { error: letGo ? why : `${why}; hold not let go`, contact: keptContact(o.contact) });
  if (ended && !letGo) await tellAdmins({ ...o, status: to }, "This domain wasn't bought, but Stripe didn't let the customer's card hold go. Cancel the payment in Stripe.");
}

/** Whether the customer's hold is there for the whole price, and Stripe's fraud check passed it. */
async function holdIsGood(o: DomainOrder): Promise<"good" | "bad" | "gone"> {
  if (o.mode === "sandbox") return "good";
  if (!o.payment_intent) return "bad";
  const p = await getPayment(o.payment_intent);
  if (p.status === "canceled") return "gone";
  const capturable = p.amount_capturable ?? p.amount;
  const risk = p.latest_charge?.outcome?.risk_level;
  if (p.status !== "requires_capture" || capturable < o.price_cents || p.currency !== "usd" || risk !== "normal" || p.review || p.latest_charge?.review) return "bad";
  return "good";
}

/** Name.com's answers that say for sure the domain wasn't bought. */
const refused = (status: number) => [400, 402, 403, 404, 405, 415, 422, 451].includes(status);

/** Tells Flash's admins about an order that needs a person. */
async function tellAdmins(o: DomainOrder, what: string): Promise<void> {
  const admins = (process.env.FLASH_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  if (!admins.length) return;
  const text = `${what}\n\nDomain: ${o.domain}\nOrder: ${o.id}\nStatus: ${o.status}\nMode: ${o.mode}\nPayment: ${o.payment_intent ?? "none"}\nName.com price: US$${(o.cost_cents / 100).toFixed(2)}\nCustomer price: US$${(o.price_cents / 100).toFixed(2)}`;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  await sendEmail(admins, { subject: `Flash domain order needs a look: ${o.domain}`, html: `<pre>${esc(text)}</pre>`, text }, "alert").catch((err) =>
    console.error("[flash] domain admin email failed", err),
  );
}

/** The domain was bought: charges the hold, keeps the domain as the customer's, then sets it up. */
async function bought(o: DomainOrder, domain: NamecomDomain | null, order: number | null, totalPaid: number | null): Promise<void> {
  let charged = true;
  if (o.mode === "live" && o.payment_intent) {
    try {
      await capturePayment(o.payment_intent);
    } catch (err) {
      const p = await getPayment(o.payment_intent).catch(() => null);
      charged = p?.status === "succeeded";
      if (!charged) console.error("[flash] domain capture failed", o.id, err);
    }
  }
  const contact = (() => {
    try {
      return JSON.parse(o.contact) as Contact;
    } catch {
      return null;
    }
  })();
  const expires = domain?.expireDate ? Date.parse(domain.expireDate) : NaN;
  const at = now();
  await run(
    `INSERT INTO owned_domains (domain, user_id, for_site, mode, status, renew, registered_at, expires_at, renewal_cost_cents,
       registrant_name, registrant_email, registrant_country, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 'remind', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET user_id = excluded.user_id, for_site = excluded.for_site, mode = excluded.mode, status = 'active',
       renew = 'remind', registered_at = excluded.registered_at, expires_at = excluded.expires_at, renewal_cost_cents = excluded.renewal_cost_cents,
       registrant_name = excluded.registrant_name, registrant_email = excluded.registrant_email, registrant_country = excluded.registrant_country,
       verified_at = 0, updated_at = excluded.updated_at`,
    [
      o.domain, o.user_id, o.for_site, o.mode, at, Number.isFinite(expires) ? expires : at + 365 * DAY,
      domain?.renewalPrice ? Math.round(domain.renewalPrice * 100) : o.renewal_cost_cents,
      contact ? `${contact.firstName} ${contact.lastName}` : "", contact?.email ?? "", contact?.country ?? "", at, at,
    ],
  );
  await move(o.id, ["buying", "unknown"], "done", {
    namecom_order: order !== null ? String(order) : null,
    total_paid_cents: totalPaid !== null ? Math.round(totalPaid * 100) : 0,
    contact: keptContact(o.contact),
    error: charged ? "" : "capture",
  });
  if (!charged) await tellAdmins({ ...o, status: "done" }, "Name.com bought this domain, but the customer's card hold couldn't be charged (it may have run out). Ask the customer to pay, or keep the domain until it expires.");
  if (totalPaid !== null && Math.round(totalPaid * 100) > o.cost_cents) {
    await tellAdmins({ ...o, status: "done" }, `Name.com charged US$${totalPaid.toFixed(2)}, more than its quoted price. Check the price formula's ICANN fee.`);
  }
  await setUp(o.id);
}

/**
 * Writes a bought domain's DNS on Name.com and connects it to its site on Vercel. Tried again by
 * the order finisher until it works. setup_at: 0 while still to do, minus the time while one run is
 * at it (for 2 minutes, so two runs don't do it at once), the time it was done once it is.
 */
async function setUp(id: string): Promise<void> {
  const at = now();
  const claimed = await run(
    "UPDATE domain_orders SET setup_at = ? WHERE id = ? AND status = 'done' AND (setup_at = 0 OR (setup_at < 0 AND -setup_at < ?))",
    [-at, id, at - 2 * MINUTE],
  );
  if (claimed.rowsAffected !== 1) return;
  const o = (await order(id))!;
  const done = (ok: boolean) => run("UPDATE domain_orders SET setup_at = ?, updated_at = ? WHERE id = ? AND setup_at = ?", [ok ? now() : 0, now(), id, -at]);
  let target: { ip: string; cname: string } | null = { ip: "76.76.21.21", cname: "cname.vercel-dns.com" };
  // Sandbox domains aren't real, so they stay off Vercel.
  if (o.mode === "live") {
    target = o.for_site ? await connectBoughtDomain(o.user_id, o.for_site, o.domain).catch(() => null) : null;
    if (!target) {
      await done(false);
      return;
    }
  }
  await done(await pointAtFlash(o.mode, o.domain, target.ip, target.cname, ownershipValue(o.user_id)).catch(() => false));
}

/** Buys the domain on Name.com, once: claims the order, checks the hold and the price, then buys. */
async function buy(o: DomainOrder): Promise<void> {
  const firstTry = o.buy_started_at === 0;
  if (!(await move(o.id, ["authorized", "unknown"], "buying", { buy_started_at: firstTry ? now() : o.buy_started_at }))) return;
  const hold = await holdIsGood(o).catch(() => null);
  if (hold === null) {
    await move(o.id, "buying", firstTry ? "authorized" : "unknown", firstTry ? { buy_started_at: 0 } : {});
    return;
  }
  if (hold !== "good") {
    // Before any purchase was tried, a bad hold ends the order. After one, it is never tried again:
    // Name.com's account says whether the first one went through.
    if (firstTry) return release({ ...o, status: "buying" }, "buying", "cancelled", hold === "gone" ? "hold gone" : "risk");
    return settleUnknown({ ...o, status: "buying" }, true);
  }
  if (firstTry) {
    // Name.com's price right before buying. A higher one than quoted is never bought.
    const fresh = (await checkNames(o.mode, [o.domain]))?.find((r) => r.domainName?.toLowerCase() === o.domain);
    if (!fresh) {
      await move(o.id, "buying", "authorized", { buy_started_at: 0 });
      return;
    }
    const cost = typeof fresh.purchasePrice === "number" ? Math.round(fresh.purchasePrice * 100) : Infinity;
    if (!fresh.purchasable || fresh.premium || cost > o.cost_cents) {
      return release({ ...o, status: "buying" }, "buying", "failed", fresh.purchasable ? "price changed" : "taken");
    }
    if (cost !== o.cost_cents) await run("UPDATE domain_orders SET cost_cents = ? WHERE id = ?", [cost, o.id]);
    o = { ...o, cost_cents: cost };
  }
  let contact: Contact;
  try {
    contact = JSON.parse(o.contact) as Contact;
  } catch {
    return release({ ...o, status: "buying" }, "buying", "failed", "contact");
  }
  const r = await buyDomain(o.mode, o.domain, o.cost_cents / 100, contact, o.id);
  if (r.status === 200 && r.json.domain) return bought({ ...o, status: "buying" }, r.json.domain, r.json.order ?? null, r.json.totalPaid ?? null);
  if (refused(r.status)) {
    // After an earlier try with no answer, the domain may be Flash's already: Name.com's account says.
    if (!firstTry) {
      const there = await getDomain(o.mode, o.domain).catch(() => undefined);
      if (there === undefined) {
        await move(o.id, "buying", "unknown");
        return;
      }
      if (there) return bought({ ...o, status: "buying" }, there, null, null);
    }
    console.warn("[flash] name.com refused domain", o.domain, r.status, r.json.message, r.json.details);
    if (r.status === 402) await tellAdmins(o, `Name.com couldn't take payment for this domain (${r.json.message ?? "402"}). Add account credit at Name.com.`);
    return release({ ...o, status: "buying" }, "buying", "failed", `name.com ${r.status}: ${String(r.json.message ?? "").slice(0, 200)}`);
  }
  console.warn("[flash] no sure answer from name.com", o.domain, r.status, r.json.message);
  await move(o.id, "buying", "unknown", { error: `name.com ${r.status || "no answer"}` });
}

/**
 * An "unknown" order that won't be tried again (past Name.com's replay window, or its hold is no
 * longer good): Name.com's account says whether the domain was bought.
 */
async function settleUnknown(o: DomainOrder, claimed = false): Promise<void> {
  if (!claimed && !(await move(o.id, "unknown", "buying"))) return;
  let there: NamecomDomain | null;
  try {
    there = await getDomain(o.mode, o.domain);
  } catch {
    await move(o.id, "buying", "unknown");
    return;
  }
  if (there) return bought({ ...o, status: "buying" }, there, null, null);
  await release({ ...o, status: "buying" }, "buying", "failed", "not bought");
}

/** Takes an order one step on, whatever it is waiting for. Safe to call any number of times, at once too. */
export async function finishOrder(id: string): Promise<void> {
  const o = await order(id);
  if (!o) return;
  const age = now() - o.created_at;
  switch (o.status) {
    case "quoted": {
      // The webhook may have been missed: Stripe's session says whether the card was held.
      if (o.mode !== "live" || !o.checkout_session) return;
      const s = await getCheckout(o.checkout_session).catch(() => null);
      if (s?.status === "complete" && s.payment_intent) {
        if (await move(id, "quoted", "authorized", { payment_intent: s.payment_intent })) await finishOrder(id);
      } else if (s?.status === "expired" || age > DAY) {
        await move(id, "quoted", "expired", { contact: keptContact(o.contact) });
      }
      return;
    }
    case "authorized":
      return buy(o);
    case "buying":
      if (now() - o.updated_at > STUCK_BUYING) await move(id, "buying", "unknown");
      return;
    case "unknown":
      if (now() - o.buy_started_at > TELL_ADMIN_AFTER && !o.admin_told_at) {
        await run("UPDATE domain_orders SET admin_told_at = ? WHERE id = ?", [now(), id]);
        await tellAdmins(o, "This domain order has had no sure answer from Name.com for 3 days, and the card is still held.");
      }
      if (now() - o.buy_started_at > REPLAY_WINDOW) return settleUnknown(o);
      return buy(o);
    case "done":
      if (o.setup_at <= 0) await setUp(id);
      return;
  }
}

/** The order finisher, every 15 minutes: orders that wait on Stripe, Name.com, or their setup. */
export async function finishOpenOrders(limit = 20): Promise<number> {
  const open = await all<{ id: string }>(
    `SELECT id FROM domain_orders
     WHERE (status IN ('quoted', 'authorized', 'buying', 'unknown') OR (status = 'done' AND setup_at <= 0)) AND created_at > ?
     ORDER BY updated_at LIMIT ?`,
    [now() - 10 * DAY, limit],
  );
  for (const { id } of open) await finishOrder(id).catch((err) => console.error("[flash] domain order finisher", id, err));
  return open.length;
}

export type OrderView = { id: string; domain: string; status: "waiting" | "buying" | "setting-up" | "live" | "not-bought"; priceCents: number; sandbox: boolean; createdAt: number };

/** How an order looks to its customer. */
export function orderView(o: Pick<DomainOrder, "id" | "domain" | "status" | "setup_at" | "price_cents" | "mode" | "created_at">): OrderView {
  const status: OrderView["status"] =
    o.status === "quoted" ? "waiting"
    : o.status === "authorized" || o.status === "buying" || o.status === "unknown" ? "buying"
    : o.status === "done" ? (o.setup_at > 0 ? "live" : "setting-up")
    : "not-bought";
  return { id: o.id, domain: o.domain, status, priceCents: o.price_cents, sandbox: o.mode === "sandbox", createdAt: o.created_at };
}

/** One order of the user's, taken a step on first so a page asking for progress also finishes it. */
export async function orderFor(userId: string, id: string): Promise<OrderView | null> {
  const before = await order(id);
  if (!before || before.user_id !== userId) return null;
  await finishOrder(id).catch((err) => console.error("[flash] domain order", id, err));
  const o = await order(id);
  return o && orderView(o);
}

/** A site's domain orders of the last 2 weeks, newest first, without quotes never paid. */
export async function ordersForSite(userId: string, slug: string): Promise<OrderView[]> {
  const rows = await all<DomainOrder>(
    "SELECT * FROM domain_orders WHERE user_id = ? AND for_site = ? AND created_at > ? AND status NOT IN ('quoted', 'expired') ORDER BY created_at DESC LIMIT 10",
    [userId, slug, now() - 14 * DAY],
  );
  return rows.map(orderView);
}
