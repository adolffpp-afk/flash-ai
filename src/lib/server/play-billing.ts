import { createSign } from "node:crypto";
import { ANDROID_PACKAGE } from "../android-app.ts";
import { isAdmin, type User } from "./auth.ts";
import { isVerified } from "./account.ts";

/*
 * Google Play Billing, the server's half (the app's half is lib/play-billing.ts). The app asks Google to
 * charge the person and sends us the purchase token; nothing is credited until Google itself says,
 * through the Play Developer API, that the token is a paid purchase of one of our products. A service
 * account (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, the key file's JSON, with access to the app in Play Console)
 * signs those calls.
 */
type Account = { client_email: string; private_key: string };

function account(): Account | null {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const key = JSON.parse(raw) as Partial<Account>;
    return key.client_email && key.private_key ? { client_email: key.client_email, private_key: key.private_key } : null;
  } catch {
    return null;
  }
}

/** Whether Play purchases can be checked here (the service account is set). */
export const playBillingConfigured = () => account() !== null;

/*
 * Until Play refunds are handled (a refund or chargeback within days of a purchase, after the credits
 * were spent, would leave Flash out of pocket), only admins and the confirmed addresses listed in
 * FLASH_PLAY_TESTERS (comma separated, the Play license testers) can buy in the app.
 */
export function playBillingOpenTo(user: Pick<User, "email" | "verified_at">): boolean {
  if (!playBillingConfigured()) return false;
  if (isAdmin(user)) return true;
  const testers = (process.env.FLASH_PLAY_TESTERS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return testers.includes(user.email.toLowerCase()) && isVerified(user);
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

let cached: { token: string; expires: number } | null = null;

async function accessToken(key: Account): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const issued = Math.floor(Date.now() / 1000);
  const claims = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: issued,
    exp: issued + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google sign-in for Play failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE}/purchases/products`;

export type PlayPurchase = {
  orderId: string;
  /** Google's own test purchases (a licence tester's), which charge no one. */
  test: boolean;
  /** 0 purchased, 1 cancelled, 2 pending. */
  purchaseState: number;
  /** 0 not yet consumed: the product can be bought again once it is. */
  consumed: boolean;
};

/** What Google says about a purchase token, or null when it knows no such purchase of this product. */
export async function lookupPurchase(sku: string, token: string): Promise<PlayPurchase | null> {
  const key = account();
  if (!key) throw new Error("Play billing isn't set up");
  const res = await fetch(`${API}/${encodeURIComponent(sku)}/tokens/${encodeURIComponent(token)}`, {
    headers: { authorization: `Bearer ${await accessToken(key)}` },
  });
  if (res.status === 400 || res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Play lookup failed (${res.status})`);
  const body = (await res.json()) as { orderId?: string; purchaseType?: number; purchaseState?: number; consumptionState?: number };
  if (!body.orderId) return null;
  return { orderId: body.orderId, test: body.purchaseType === 0, purchaseState: body.purchaseState ?? 1, consumed: body.consumptionState === 1 };
}

/**
 * Tells Google the credits were given. That also acknowledges the purchase (unacknowledged ones are
 * refunded after three days) and lets the person buy the same pack again.
 */
export async function consumePurchase(sku: string, token: string): Promise<void> {
  const key = account();
  if (!key) throw new Error("Play billing isn't set up");
  const res = await fetch(`${API}/${encodeURIComponent(sku)}/tokens/${encodeURIComponent(token)}:consume`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(key)}` },
  });
  if (!res.ok && res.status !== 400) throw new Error(`Play consume failed (${res.status})`);
}

export type VoidedPurchase = { orderId: string; voidedAt: number };

/**
 * Orders Google has voided since a time (ms): refunds, chargebacks and cancellations of in-app products.
 * Google keeps 30 days of them.
 */
export async function voidedSince(sinceMs: number): Promise<VoidedPurchase[]> {
  const key = account();
  if (!key) throw new Error("Play billing isn't set up");
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${ANDROID_PACKAGE}/purchases/voidedpurchases`;
  const found: VoidedPurchase[] = [];
  let page = "";
  do {
    const query = new URLSearchParams({ startTime: String(sinceMs), maxResults: "1000" });
    if (page) query.set("token", page);
    const res = await fetch(`${base}?${query}`, { headers: { authorization: `Bearer ${await accessToken(key)}` } });
    if (!res.ok) throw new Error(`Play voided purchases failed (${res.status})`);
    const body = (await res.json()) as {
      voidedPurchases?: { orderId?: string; voidedTimeMillis?: string }[];
      tokenPagination?: { nextPageToken?: string };
    };
    for (const v of body.voidedPurchases ?? []) {
      if (v.orderId) found.push({ orderId: v.orderId, voidedAt: Number(v.voidedTimeMillis ?? 0) });
    }
    page = body.tokenPagination?.nextPageToken ?? "";
  } while (page);
  return found;
}
