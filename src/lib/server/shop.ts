import { all, one, run, now } from "./db.ts";
import { isAdmin, type User } from "./auth.ts";
import { activeSubscription } from "./subscriptions.ts";
import { paymentsEnabled, stripe } from "./stripe.ts";
import { domainsForSite } from "./domains.ts";
import { randomId } from "./ids.ts";
import { overLimit } from "./limits.ts";
import { EMAILS, sendEmail } from "./email.ts";
import { MAX_QUANTITY, MIN_PRICE, SELLER_COUNTRIES, cleanItemName, formatMoney, safeReturn, saleFee, toMinor } from "../shop.ts";

/*
 * Selling from published sites. Each seller connects their own Stripe account (a Standard-style
 * account: the seller pays Stripe's fees and Stripe covers losses), and sites charge on it
 * directly, so the money goes to the seller and Flash keeps a small share of each sale. Flash
 * pays nothing per seller or per sale, so selling never runs at a loss.
 */

const HOUR = 3_600_000;
/** Flash's share of each sale, in basis points (200 = 2%). */
const feeBps = () => Number(process.env.FLASH_SALE_FEE_BPS ?? 200);

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
const stripeReason = (user: User, err: unknown) => (isAdmin(user) && err instanceof Error ? ` Stripe says: ${err.message}` : "");

/** Stripe's sign-up page for the seller's account, creating the account the first time. */
export async function sellerOnboardingLink(user: User, country: unknown, origin: string): Promise<{ url: string } | { error: string; status: number }> {
  if (!sellingAvailable()) return { error: "Selling isn't switched on yet.", status: 503 };
  if (!(await canSell(user))) return { error: "Selling comes with a paid plan.", status: 402 };
  let row = await sellerRow(user.id);
  if (!row) {
    const code = SELLER_COUNTRIES.find(([c]) => c === country)?.[0];
    if (!code) return { error: "Pick the country your business is in.", status: 400 };
    if (await overLimit(`seller-create:${user.id}`, 10, 24 * HOUR)) return { error: "Too many tries today. Please try again tomorrow.", status: 429 };
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
      return { error: `Couldn't start the Stripe sign-up. Please try again later.${stripeReason(user, err)}`, status: 502 };
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
        refresh_url: `${origin}/api/payments/link`,
        return_url: `${origin}/?apps=1`,
      }),
    );
    return { url: link.url };
  } catch (err) {
    console.error("[flash] stripe account link failed", err);
    return { error: `Couldn't open the Stripe sign-up. Please try again later.${stripeReason(user, err)}`, status: 502 };
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

/** Adds an item for sale on the site, or changes the price of one with the same name. */
export async function saveProduct(
  user: User,
  slug: string,
  input: { name?: unknown; price?: unknown; delivery?: unknown },
): Promise<Product | { error: string; status: number }> {
  const seller = await sellerStatus(user.id);
  if (!seller.ready || !seller.currency) return { error: "Connect your Stripe account first.", status: 409 };
  const name = cleanItemName(input.name);
  if (!name) return { error: "Give the item a name (up to 80 characters).", status: 400 };
  const price = toMinor(String(input.price ?? ""), seller.currency);
  if (price === null || price < MIN_PRICE) {
    return { error: `Type a price of at least ${formatMoney(MIN_PRICE, seller.currency)}, like 12.50.`, status: 400 };
  }
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM site_products WHERE site_slug = ?", [slug]);
  const existing = await one<{ id: string }>("SELECT id FROM site_products WHERE site_slug = ? AND name = ?", [slug, name]);
  if (!existing && Number(count?.n ?? 0) >= 200) return { error: "A site can sell up to 200 items.", status: 409 };
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
  return one<{ title: string; email: string; stripe_account: string; country: string }>(
    `SELECT s.title, u.email, a.stripe_account, a.country FROM sites s
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
): Promise<{ url: string } | { error: string; status: number }> {
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
    const session = await stripe<{ url?: string }>("POST", "/checkout/sessions", form, shop.stripe_account);
    if (!session.url) throw new Error("Stripe didn't return a checkout link");
    return { url: session.url };
  } catch (err) {
    console.error("[flash] site checkout failed", slug, err);
    return { error: "Payments aren't working right now. Please try again later.", status: 502 };
  }
}

type Session = {
  id: string;
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

/** Saves a paid order once; true when it is new. */
async function recordOrder(slug: string, s: Session): Promise<boolean> {
  if (s.payment_status !== "paid" || s.metadata?.flash_site !== slug) return false;
  const res = await run(
    `INSERT INTO site_orders (session_id, site_slug, item, quantity, amount, currency, email, name, address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
    [
      s.id,
      slug,
      s.metadata.flash_item ?? "",
      s.line_items?.data?.[0]?.quantity ?? 1,
      s.amount_total ?? 0,
      s.currency ?? "",
      s.customer_details?.email ?? "",
      s.customer_details?.name ?? "",
      addressText(s),
      s.created ? s.created * 1000 : now(),
    ],
  );
  return res.rowsAffected > 0;
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
  if (!session || session.payment_status !== "paid" || session.metadata?.flash_site !== slug) return { page, paid: false };
  if (await recordOrder(slug, session)) {
    const summary = [
      `${session.line_items?.data?.[0]?.quantity ?? 1} × ${session.metadata.flash_item}`,
      `Paid: ${formatMoney(session.amount_total ?? 0, session.currency ?? "usd")}`,
      session.customer_details?.name && `Name: ${session.customer_details.name}`,
      session.customer_details?.email && `Email: ${session.customer_details.email}`,
      addressText(session) && `Deliver to: ${addressText(session)}`,
    ]
      .filter(Boolean)
      .join("\n");
    await sendEmail(shop.email, EMAILS.siteOrder(shop.title, summary, `${appOrigin}/?apps=1`)).catch((err) =>
      console.error("[flash] order email failed", err),
    );
  }
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
};

/**
 * The site's orders, newest first. Recent paid checkouts are fetched from Stripe first, so orders
 * whose buyer closed the page before coming back show up too.
 */
export async function listOrders(userId: string, slug: string): Promise<Order[]> {
  const seller = await sellerRow(userId);
  if (seller?.ready && sellingAvailable()) {
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
  }>("SELECT * FROM site_orders WHERE site_slug = ? ORDER BY created_at DESC LIMIT 500", [slug]);
  return rows.map((r) => ({
    id: r.session_id,
    item: r.item,
    quantity: Number(r.quantity),
    total: formatMoney(Number(r.amount), r.currency),
    email: r.email,
    name: r.name,
    address: r.address,
    createdAt: Number(r.created_at),
    done: Boolean(Number(r.done_at)),
  }));
}

/** Marks an order as handled (sent or picked up), or not. False if the site has no such order. */
export async function markOrder(slug: string, id: string, done: boolean): Promise<boolean> {
  const res = await run("UPDATE site_orders SET done_at = ? WHERE site_slug = ? AND session_id = ?", [done ? now() : 0, slug, id]);
  return res.rowsAffected > 0;
}
