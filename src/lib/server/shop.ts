import { all, one, run, now } from "./db.ts";
import { isAdmin, type User } from "./auth.ts";
import { activeSubscription } from "./subscriptions.ts";
import { liveKey, paymentsEnabled, stripe } from "./stripe.ts";
import { domainsForSite } from "./domains.ts";
import { randomId } from "./ids.ts";
import { overLimit } from "./limits.ts";
import { EMAILS, sendEmail } from "./email.ts";
import { noteContact } from "./contacts.ts";
import { saleBySource } from "./funnel.ts";
import { cleanContact } from "../contacts.ts";
import { MAX_QUANTITY, MIN_PRICE, SELLER_COUNTRIES, cleanItemName, formatMoney, orderRefund, safeReturn, saleFee, toMinor, type OrderRefund } from "../shop.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * Selling from published sites. Each seller connects their own Stripe account (a Standard-style
 * account: the seller pays Stripe's fees and Stripe covers losses), and sites charge on it
 * directly, so the money goes to the seller and Flash keeps a small share of each sale. Flash
 * pays nothing per seller or per sale, so selling never runs at a loss.
 */

const HOUR = 3_600_000;
/** Flash's share of each sale, in basis points (200 = 2%). */
export const feeBps = () => Number(process.env.FLASH_SALE_FEE_BPS ?? 200);

export const sellingAvailable = paymentsEnabled;

/** Selling comes with a paid plan (and Flash's admins), like custom domains, which keeps scam shops off. */
export async function canSell(user: User): Promise<boolean> {
  return isAdmin(user) || Boolean(await activeSubscription(user.id));
}

type SellerRow = { stripe_account: string; country: string; currency: string; ready: number };
export type SellerStatus = { connected: boolean; ready: boolean; currency: string; country: string };

const sellerRow = (userId: string) =>
  one<SellerRow>("SELECT stripe_account, country, currency, ready FROM seller_accounts WHERE user_id = ?", [userId]);

/** Where the seller's Stripe account stands, asking Stripe when it isn't ready yet. */
export async function sellerStatus(userId: string): Promise<SellerStatus> {
  const row = await sellerRow(userId);
  if (!row) return { connected: false, ready: false, currency: "", country: "" };
  if (row.ready) return { connected: true, ready: true, currency: row.currency, country: row.country };
  const account = await stripe<{ charges_enabled?: boolean; default_currency?: string; country?: string }>(
    "GET",
    `/accounts/${encodeURIComponent(row.stripe_account)}`,
  ).catch((err) => {
    console.error("[flash] stripe account check failed", err);
    return null;
  });
  if (!account) return { connected: true, ready: false, currency: row.currency, country: row.country };
  const status = {
    connected: true,
    ready: Boolean(account.charges_enabled),
    currency: (account.default_currency || row.currency).toLowerCase(),
    country: account.country || row.country,
  };
  await run("UPDATE seller_accounts SET ready = ?, currency = ?, country = ? WHERE user_id = ?", [
    status.ready ? 1 : 0,
    status.currency,
    status.country,
    userId,
  ]);
  return status;
}

/** Stripe's own reason, shown to Flash's admins only, so a setup problem can be fixed without reading server logs. */
const stripeReason = (user: User, err: unknown) => (isAdmin(user) && err instanceof Error ? err.message : null);

/**
 * Stripe's sign-up page for the seller's account, creating the account the first time. `t` words
 * the reasons it can't, for the seller in Flash.
 */
export async function sellerOnboardingLink(
  user: User,
  country: unknown,
  origin: string,
  t: Translate = english,
): Promise<{ url: string } | { error: string; status: number }> {
  if (!sellingAvailable()) return { error: t("Selling isn't switched on yet."), status: 503 };
  if (!(await canSell(user))) return { error: t("Selling comes with a paid plan."), status: 402 };
  let row = await sellerRow(user.id);
  if (!row) {
    const code = SELLER_COUNTRIES.find(([c]) => c === country)?.[0];
    if (!code) return { error: t("Pick the country your business is in."), status: 400 };
    if (await overLimit(`seller-create:${user.id}`, 10, 24 * HOUR)) return { error: t("Too many tries today. Please try again tomorrow."), status: 429 };
    try {
      const account = await stripe<{ id: string; default_currency?: string }>(
        "POST",
        "/accounts",
        new URLSearchParams({
          country: code,
          email: user.email,
          "controller[fees][payer]": "account",
          "controller[losses][payments]": "stripe",
          "controller[stripe_dashboard][type]": "full",
          "controller[requirement_collection]": "stripe",
          "metadata[flash_user]": user.id,
        }),
      );
      await run("INSERT INTO seller_accounts (user_id, stripe_account, country, currency, created_at) VALUES (?, ?, ?, ?, ?)", [
        user.id,
        account.id,
        code,
        (account.default_currency ?? "").toLowerCase(),
        now(),
      ]);
      row = { stripe_account: account.id, country: code, currency: account.default_currency ?? "", ready: 0 };
    } catch (err) {
      console.error("[flash] stripe seller account failed", err);
      const reason = stripeReason(user, err);
      return {
        error:
          reason === null
            ? t("Couldn't start the Stripe sign-up. Please try again later.")
            : t("Couldn't start the Stripe sign-up. Please try again later. Stripe says: {reason}", { reason }),
        status: 502,
      };
    }
  }
  try {
    const link = await stripe<{ url: string }>(
      "POST",
      "/account_links",
      new URLSearchParams({
        account: row.stripe_account,
        type: "account_onboarding",
        // Stripe's links expire after a few minutes; the refresh address makes a new one.
        // Both name the account, so they open as it in a browser signed in to several (see auth.ts).
        refresh_url: `${origin}/api/payments/link?as=${encodeURIComponent(user.id)}`,
        return_url: `${origin}/?apps=1&as=${encodeURIComponent(user.id)}`,
      }),
    );
    return { url: link.url };
  } catch (err) {
    console.error("[flash] stripe account link failed", err);
    const reason = stripeReason(user, err);
    return {
      error:
        reason === null
          ? t("Couldn't open the Stripe sign-up. Please try again later.")
          : t("Couldn't open the Stripe sign-up. Please try again later. Stripe says: {reason}", { reason }),
      status: 502,
    };
  }
}

export type Product = { id: string; name: string; price: number; currency: string; label: string; delivery: boolean };

export async function listProducts(slug: string): Promise<Product[]> {
  const rows = await all<{ id: string; name: string; price: number; currency: string; delivery: number }>(
    "SELECT id, name, price, currency, delivery FROM site_products WHERE site_slug = ? ORDER BY created_at",
    [slug],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price),
    currency: r.currency,
    label: formatMoney(Number(r.price), r.currency),
    delivery: Boolean(r.delivery),
  }));
}

/** Adds an item for sale on the site, or changes the price of one with the same name. `t` words the reasons it can't. */
export async function saveProduct(
  user: User,
  slug: string,
  input: { name?: unknown; price?: unknown; delivery?: unknown },
  t: Translate = english,
): Promise<Product | { error: string; status: number }> {
  const seller = await sellerStatus(user.id);
  if (!seller.ready || !seller.currency) return { error: t("Connect your Stripe account first."), status: 409 };
  const name = cleanItemName(input.name);
  if (!name) return { error: t("Give the item a name (up to 80 characters)."), status: 400 };
  const price = toMinor(String(input.price ?? ""), seller.currency);
  if (price === null || price < MIN_PRICE) {
    return { error: t("Type a price of at least {price}, like 12.50.", { price: formatMoney(MIN_PRICE, seller.currency) }), status: 400 };
  }
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_products WHERE site_slug = ?", [slug]);
  const existing = await one<{ id: string }>("SELECT id FROM site_products WHERE site_slug = ? AND name = ?", [slug, name]);
  if (!existing && Number(count?.n ?? 0) >= 200) return { error: t("A site can sell up to 200 items."), status: 409 };
  const id = existing?.id ?? randomId();
  await run(
    `INSERT INTO site_products (id, site_slug, name, price, currency, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_slug, name) DO UPDATE SET name = excluded.name, price = excluded.price, currency = excluded.currency, delivery = excluded.delivery`,
    [id, slug, name, price, seller.currency, input.delivery ? 1 : 0, now()],
  );
  return { id, name, price, currency: seller.currency, label: formatMoney(price, seller.currency), delivery: Boolean(input.delivery) };
}

export async function deleteProduct(slug: string, id: string): Promise<void> {
  await run("DELETE FROM site_products WHERE site_slug = ? AND id = ?", [slug, id]);
}

/** The owner and Stripe account behind a site, when it can take payments. */
async function shopOf(slug: string) {
  return one<{ title: string; email: string; user_id: string; stripe_account: string; country: string }>(
    `SELECT s.title, u.email, s.user_id, a.stripe_account, a.country FROM sites s
       JOIN users u ON u.id = s.user_id
       JOIN seller_accounts a ON a.user_id = s.user_id AND a.ready = 1
     WHERE s.slug = ?`,
    [slug],
  );
}

/** What the site sells, with prices for people to read (the site shows them with data-flash-price). */
export async function publicItems(slug: string): Promise<{ name: string; price: string }[]> {
  if (!sellingAvailable() || !(await shopOf(slug))) return [];
  return (await listProducts(slug)).map((p) => ({ name: p.name, price: p.label }));
}

/** The addresses a site is shown on, so visitors can be sent back to the one they bought from. */
async function siteAddresses(slug: string, appOrigin: string): Promise<string[]> {
  return [`${appOrigin}/p/${slug}`, ...(await domainsForSite(slug)).map((d) => `https://${d}`)];
}

/** Starts a Stripe Checkout for an item on a site (window.flashDB.buy) and returns its address. */
export async function startCheckout(
  slug: string,
  input: { item?: unknown; quantity?: unknown; page?: unknown },
  ip: string,
  appOrigin: string,
): Promise<{ url: string; id: string } | { error: string; status: number }> {
  if (!sellingAvailable()) return { error: "This site can't take payments yet.", status: 503 };
  const name = cleanItemName(input.item);
  if (!name) return { error: "Which item? Pass its name to flashDB.buy.", status: 400 };
  const quantity = Math.floor(Number(input.quantity ?? 1));
  if (!(quantity >= 1 && quantity <= MAX_QUANTITY)) return { error: `You can buy 1 to ${MAX_QUANTITY} at a time.`, status: 400 };
  if ((await overLimit(`shop-ip:${ip}`, 30, HOUR)) || (await overLimit(`shop-site:${slug}`, 1000, 24 * HOUR))) {
    return { error: "Too many tries. Please try again later.", status: 429 };
  }
  const shop = await shopOf(slug);
  if (!shop) return { error: "This site can't take payments yet.", status: 409 };
  const product = await one<{ name: string; price: number; currency: string; delivery: number }>(
    "SELECT name, price, currency, delivery FROM site_products WHERE site_slug = ? AND name = ?",
    [slug, name],
  );
  if (!product) return { error: `"${name}" isn't for sale yet.`, status: 404 };
  const back = safeReturn(input.page, await siteAddresses(slug, appOrigin));
  const total = Number(product.price) * quantity;
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": String(quantity),
    "line_items[0][price_data][currency]": product.currency,
    "line_items[0][price_data][unit_amount]": String(product.price),
    "line_items[0][price_data][product_data][name]": product.name,
    "payment_intent_data[application_fee_amount]": String(saleFee(total, feeBps())),
    "payment_intent_data[description]": `${shop.title.slice(0, 80)}: ${product.name}`,
    "metadata[flash_site]": slug,
    "metadata[flash_item]": product.name,
    success_url: `${appOrigin}/api/sites/${slug}/shop/done?session={CHECKOUT_SESSION_ID}&back=${encodeURIComponent(back)}`,
    cancel_url: back,
  });
  if (product.delivery) {
    form.set("shipping_address_collection[allowed_countries][0]", shop.country);
    form.set("phone_number_collection[enabled]", "true");
  }
  try {
    const session = await stripe<{ id?: string; url?: string }>("POST", "/checkout/sessions", form, shop.stripe_account);
    if (!session.url) throw new Error("Stripe didn't return a checkout link");
    // The session's id keeps where the buyer came from until the order is saved (see funnel.ts); the page only gets the link.
    return { url: session.url, id: session.id ?? "" };
  } catch (err) {
    console.error("[flash] site checkout failed", slug, err);
    return { error: "Payments aren't working right now. Please try again later.", status: 502 };
  }
}

type Session = {
  id: string;
  livemode?: boolean;
  payment_status?: string;
  amount_total?: number;
  currency?: string;
  created?: number;
  metadata?: Record<string, string>;
  customer_details?: { email?: string | null; name?: string | null; phone?: string | null } | null;
  shipping_details?: Shipping;
  collected_information?: { shipping_details?: Shipping } | null;
  line_items?: { data?: { quantity?: number }[] };
};
type Shipping = { name?: string | null; address?: Record<string, string | null> | null } | null | undefined;

function addressText(s: Session): string {
  const ship = s.collected_information?.shipping_details ?? s.shipping_details;
  if (!ship?.address) return "";
  const a = ship.address;
  return [ship.name, a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(" "), a.state, a.country, s.customer_details?.phone]
    .filter(Boolean)
    .join(", ");
}

/** What a refund or a dispute said of an order it is the first to save (see chargeEvent). */
type Since = { at: number; refunded?: number; disputed?: boolean };

/**
 * Saves a paid order once, with its buyer on the app's contact list; true when it is new. The return
 * page (finishCheckout), the owner's sync (syncOrders) and Stripe's webhook (connectEvent) all save
 * through here, so a sale is one order, new once, whichever of them sees it first. An order a refund
 * or a dispute is the first to save is saved already refunded or disputed (since), in the same
 * INSERT, so nothing that reads a new order ever takes it for a plain sale.
 */
async function recordOrder(slug: string, s: Session, since?: Since): Promise<boolean> {
  // A test-mode payment is never an order under a live key, nor a live one under a test key.
  if (s.payment_status !== "paid" || s.metadata?.flash_site !== slug || s.livemode !== liveKey()) return false;
  const item = s.metadata.flash_item ?? "";
  const created = s.created ? s.created * 1000 : now();
  const given = s.customer_details?.email ?? "";
  const buyer = cleanContact({ email: given, name: s.customer_details?.name, phone: s.customer_details?.phone });
  // An address Stripe gives in another spelling than the one contacts keep (see cleanEmail), beyond
  // the case of A to Z (all the database's lower() changes), is saved in the contacts' spelling: the
  // buyer's contact then finds the order, and deleting them clears their address from it.
  const email = buyer?.email && buyer.email !== given.replace(/[A-Z]+/g, (s) => s.toLowerCase()) ? buyer.email : given;
  // A refund is never more than the order (as in chargeEvent's UPDATE).
  const refunded = Math.min(since?.refunded ?? 0, s.amount_total ?? 0);
  const res = await run(
    `INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at, refunded_amount, refunded_at, disputed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
    [
      s.id,
      slug,
      item,
      s.line_items?.data?.[0]?.quantity ?? 1,
      s.amount_total ?? 0,
      s.currency ?? "",
      email,
      s.customer_details?.name ?? "",
      addressText(s),
      created,
      refunded,
      since && refunded > 0 ? since.at : 0,
      since?.disputed ? since.at : 0,
    ],
  );
  if (!res.rowsAffected) return false;
  // The sale goes into its day's total under where its buyer came from, and nothing about the buyer
  // with it (see funnel.ts). One that can't be counted never stops the order.
  await saleBySource(slug, s.id, created, s.currency ?? "", s.amount_total ?? 0).catch((err) => console.error("[flash] sale not counted", err));
  // Paying isn't agreeing to news, so no consent is kept. A contact that can't be saved never stops the order.
  if (buyer) await noteContact(slug, buyer, { source: `order:${item.slice(0, 60)}`, at: created }).catch((err) => console.error("[flash] contact not saved", err));
  return true;
}

type Shop = NonNullable<Awaited<ReturnType<typeof shopOf>>>;

/** Saves a paid order, and the first time emails its owner. True when it is new. */
async function orderPaid(slug: string, session: Session, shop: Shop, appOrigin: string): Promise<boolean> {
  if (!(await recordOrder(slug, session))) return false;
  const summary = [
    `${session.line_items?.data?.[0]?.quantity ?? 1} × ${session.metadata?.flash_item ?? ""}`,
    `Paid: ${formatMoney(session.amount_total ?? 0, session.currency ?? "usd")}`,
    session.customer_details?.name && `Name: ${session.customer_details.name}`,
    session.customer_details?.email && `Email: ${session.customer_details.email}`,
    addressText(session) && `Deliver to: ${addressText(session)}`,
  ]
    .filter(Boolean)
    .join("\n");
  // Orders aren't held to the owner's cap for form messages (see EMAIL_BUDGET), only the day's budget.
  // The link names the owner's account, so it opens as it in a browser signed in to several (see auth.ts).
  await sendEmail(shop.email, EMAILS.siteOrder(shop.title, summary, `${appOrigin}/?apps=1&as=${encodeURIComponent(shop.user_id)}`), "other").catch((err) =>
    console.error("[flash] order email failed", err),
  );
  return true;
}

/**
 * A visitor comes back from paying: saves the order, emails the owner, and gives the page to send
 * the visitor back to. The session is read from Stripe, so a made-up link records nothing.
 */
export async function finishCheckout(slug: string, sessionId: string, back: unknown, appOrigin: string): Promise<{ page: string; paid: boolean }> {
  const page = safeReturn(back, await siteAddresses(slug, appOrigin));
  const shop = await shopOf(slug);
  if (!shop || !/^cs_[\w]+$/.test(sessionId)) return { page, paid: false };
  const session = await stripe<Session>(
    "GET",
    `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`,
    undefined,
    shop.stripe_account,
  ).catch((err) => {
    console.error("[flash] site checkout lookup failed", err);
    return null;
  });
  if (!session || session.payment_status !== "paid" || session.metadata?.flash_site !== slug || session.livemode !== liveKey()) {
    return { page, paid: false };
  }
  await orderPaid(slug, session, shop, appOrigin);
  return { page, paid: true };
}

export type Order = {
  id: string;
  item: string;
  quantity: number;
  total: string;
  email: string;
  name: string;
  address: string;
  createdAt: number;
  done: boolean;
} & OrderRefund;

/**
 * Saves the site's recent paid checkouts from Stripe, with their buyers on its contact list, so
 * orders whose buyer closed the page before coming back, or whose payment went through later,
 * show up too. For Orders and Contacts, when the owner opens them.
 */
export async function syncOrders(userId: string, slug: string): Promise<void> {
  const seller = await sellerRow(userId);
  if (!seller?.ready || !sellingAvailable()) return;
  const recent = await stripe<{ data?: Session[] }>(
    "GET",
    "/checkout/sessions?limit=100&status=complete&expand[]=data.line_items",
    undefined,
    seller.stripe_account,
  ).catch((err) => {
    console.error("[flash] order sync failed", err);
    return null;
  });
  for (const s of recent?.data ?? []) await recordOrder(slug, s);
}

/** The site's orders, newest first, with its recent paid checkouts fetched from Stripe first. */
export async function listOrders(userId: string, slug: string): Promise<Order[]> {
  await syncOrders(userId, slug);
  const rows = await all<{
    session_id: string;
    item: string;
    quantity: number;
    amount: number;
    currency: string;
    email: string;
    name: string;
    address: string;
    created_at: number;
    done_at: number;
    refunded_amount: number;
    disputed_at: number;
  }>("SELECT * FROM site_orders WHERE site_slug = ? ORDER BY created_at DESC LIMIT 500", [slug]);
  return rows.map(
    (r): Order => ({
      id: r.session_id,
      item: r.item,
      quantity: Number(r.quantity),
      total: formatMoney(Number(r.amount), r.currency),
      email: r.email,
      name: r.name,
      address: r.address,
      createdAt: Number(r.created_at),
      done: Boolean(Number(r.done_at)),
      ...orderRefund(r),
    }),
  );
}

/** Marks an order as handled (sent or picked up), or not. False if the site has no such order. */
export async function markOrder(slug: string, id: string, done: boolean): Promise<boolean> {
  const res = await run("UPDATE site_orders SET done_at = ? WHERE site_slug = ? AND session_id = ?", [done ? now() : 0, slug, id]);
  return res.rowsAffected > 0;
}

/** An event Stripe sent the Connect webhook, as it came: nothing in it counts until it is checked. */
export type ConnectEvent = { id?: unknown; type?: unknown; account?: unknown; livemode?: unknown; created?: unknown; data?: { object?: unknown } | null };
/** What the webhook did with an event (its answer says it, for Stripe's event log and the tests). */
export type ConnectOutcome = "ignored" | "not-ours" | "duplicate" | "unpaid" | "recorded" | "unchanged" | "refunded" | "disputed";

/** The events the webhook is pointed at; Stripe is answered 200 for any other, so it stops sending it. */
const CONNECT_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "charge.refunded", "charge.dispute.created"];
const isId = (v: unknown, prefix: string): v is string => typeof v === "string" && v.length <= 255 && new RegExp(`^${prefix}_\\w+$`).test(v);

/**
 * Handles an event from a seller's connected Stripe account, sent to Stripe's Connect webhook (see
 * api/stripe/connect), its signature already checked: a checkout paid, or paid days later (a bank
 * debit, a voucher), saves its order and emails the owner, as the return page would have; a refund
 * or a dispute is kept with its order. Each event changes something once, and only for an app whose
 * owner's account sent it, in the key's own mode. Throws when Stripe or the database fails, so
 * Stripe sends it again later.
 */
export async function connectEvent(event: ConnectEvent, appOrigin: string): Promise<ConnectOutcome> {
  const { type, account } = event;
  const object = event.data?.object;
  if (typeof type !== "string" || !CONNECT_EVENTS.includes(type) || !isId(event.id, "evt") || !object || typeof object !== "object") return "ignored";
  // Stripe also sends a live endpoint its connected accounts' test-mode events: those never become
  // orders under a live key (nor live ones under a test key). Nor does an event of Flash's own account.
  if (event.livemode !== liveKey() || !isId(account, "acct")) return "ignored";
  // A seller's account can sell elsewhere too: Stripe isn't asked about the accounts Flash didn't connect.
  if (!(await one("SELECT 1 FROM seller_accounts WHERE stripe_account = ? AND ready = 1", [account]))) return "not-ours";
  if (await one("SELECT 1 FROM stripe_events WHERE id = ?", [event.id])) return "duplicate";
  const at = typeof event.created === "number" && event.created > 0 ? event.created * 1000 : now();
  const outcome =
    type === "charge.refunded" || type === "charge.dispute.created"
      ? await chargeEvent(type, account, object as Record<string, unknown>, at)
      : await sessionEvent(account, object as Session, appOrigin);
  // Kept only once handled, so an event that failed halfway is handled again when Stripe resends it.
  // A seller's sales elsewhere change nothing, sent again or not, and write nothing.
  if (outcome !== "not-ours") await run("INSERT OR IGNORE INTO stripe_events (id, created_at) VALUES (?, ?)", [event.id, now()]);
  return outcome;
}

/** The app a checkout session is for, when that app's owner's connected account is the one that sent it. */
async function shopFor(account: string, session: Session | undefined) {
  const slug = session?.metadata?.flash_site;
  if (!session || !isId(session.id, "cs") || typeof slug !== "string" || !slug) return null;
  const shop = await shopOf(slug);
  return shop && shop.stripe_account === account ? { slug, shop } : null;
}

async function sessionEvent(account: string, sent: Session, appOrigin: string): Promise<ConnectOutcome> {
  // A bank debit's checkout completes unpaid; checkout.session.async_payment_succeeded follows once it's paid.
  if (sent.payment_status !== "paid") return "unpaid";
  const mine = await shopFor(account, sent);
  if (!mine) return "not-ours";
  // Read from Stripe again on that account, with what was bought: an event leaves the line items out.
  const session = await stripe<Session>("GET", `/checkout/sessions/${encodeURIComponent(sent.id)}?expand[]=line_items`, undefined, account);
  return (await orderPaid(mine.slug, session, mine.shop, appOrigin)) ? "recorded" : "unchanged";
}

async function chargeEvent(type: "charge.refunded" | "charge.dispute.created", account: string, object: Record<string, unknown>, at: number): Promise<ConnectOutcome> {
  let payment = object.payment_intent;
  // A dispute names its charge, and its payment only on newer API versions.
  if (!isId(payment, "pi") && type === "charge.dispute.created" && isId(object.charge, "ch")) {
    payment = (await stripe<{ payment_intent?: string | null }>("GET", `/charges/${encodeURIComponent(object.charge)}`, undefined, account)).payment_intent;
  }
  if (!isId(payment, "pi")) return "not-ours";
  const found = await stripe<{ data?: Session[] }>(
    "GET",
    `/checkout/sessions?${new URLSearchParams({ payment_intent: payment, limit: "1", "expand[]": "data.line_items" })}`,
    undefined,
    account,
  );
  const session = found.data?.[0];
  const mine = await shopFor(account, session);
  if (!session || !mine) return "not-ours";
  // How much of the charge has gone back so far, with each refund. One sent late never lowers it.
  const refunded = type === "charge.refunded" ? Math.max(0, Math.floor(Number(object.amount_refunded) || 0)) : 0;
  // Refunded or disputed before its order was saved (the buyer closed the tab, an event was lost):
  // saved now, the same order the other ways save, already refunded or disputed, without a
  // new-order email (see recordOrder).
  await recordOrder(mine.slug, session, type === "charge.refunded" ? { at, refunded } : { at, disputed: true });
  if (type === "charge.refunded") {
    await run(
      "UPDATE site_orders SET refunded_amount = MIN(?, amount), refunded_at = ? WHERE session_id = ? AND site_slug = ? AND refunded_amount < MIN(?, amount)",
      [refunded, at, session.id, mine.slug, refunded],
    );
    return "refunded";
  }
  await run("UPDATE site_orders SET disputed_at = ? WHERE session_id = ? AND site_slug = ? AND disputed_at = 0", [at, session.id, mine.slug]);
  return "disputed";
}
