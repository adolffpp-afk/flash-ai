/*
 * Google Play Billing, the app's half (see server/play-billing.ts): inside Flash's Android app, Chrome
 * hands the page the Digital Goods API (prices and what the person owns) and Payment Request (the Play
 * purchase sheet). Elsewhere neither exists, so every call here answers "not available".
 */
import { PLAY_PACKS } from "./credits.ts";

const PLAY = "https://play.google.com/billing";

type Service = {
  getDetails(skus: string[]): Promise<{ itemId: string; title: string; price: { currency: string; value: string } }[]>;
  listPurchases(): Promise<{ itemId: string; purchaseToken: string }[]>;
};

/** Why Play's service isn't here, for an admin to read (see PlayTopUp); null when it is. */
export let playTrouble: string | null = null;

/** Play's own service, or null outside the Android app. */
async function service(): Promise<Service | null> {
  const w = window as unknown as { getDigitalGoodsService?: (provider: string) => Promise<Service> };
  if (typeof w.getDigitalGoodsService !== "function") {
    playTrouble = "This page has no Google Play billing: the app must be 1.0.2 or newer and installed from Google Play (not the .apk file).";
    return null;
  }
  try {
    playTrouble = null;
    return await w.getDigitalGoodsService(PLAY);
  } catch (err) {
    playTrouble = `Google Play billing didn't start: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

/** The price Play shows for each pack, by pack id; null when Play billing isn't available here. */
export async function playPrices(): Promise<Record<string, string> | null> {
  const play = await service();
  if (!play) return null;
  try {
    const details = await play.getDetails(PLAY_PACKS.map((p) => p.sku));
    const prices: Record<string, string> = {};
    for (const d of details) {
      const pack = PLAY_PACKS.find((p) => p.sku === d.itemId);
      if (!pack) continue;
      try {
        prices[pack.id] = new Intl.NumberFormat(undefined, { style: "currency", currency: d.price.currency }).format(Number(d.price.value));
      } catch {
        prices[pack.id] = `${d.price.value} ${d.price.currency}`;
      }
    }
    if (!Object.keys(prices).length) {
      playTrouble = `Google Play knows none of the products (${PLAY_PACKS.map((p) => p.sku).join(", ")}): they must be active, and this app version must be on a release track.`;
      return null;
    }
    return prices;
  } catch (err) {
    playTrouble = `Google Play couldn't give the prices: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

/** Opens Play's purchase sheet for a pack: its purchase token, or null when the person closed the sheet. */
export async function buyOnPlay(sku: string): Promise<string | null> {
  const request = new PaymentRequest(
    [{ supportedMethods: PLAY, data: { sku } }],
    // Play charges its own price; the API only wants a total.
    { total: { label: "Total", amount: { currency: "USD", value: "0" } } },
  );
  try {
    const response = await request.show();
    const token = (response.details as { purchaseToken?: string }).purchaseToken;
    await response.complete(token ? "success" : "fail");
    return token ?? null;
  } catch (err) {
    if (err instanceof DOMException && (err.name === "AbortError" || err.name === "NotAllowedError")) return null;
    throw err;
  }
}

/** Purchases made but not yet credited (the app closed after paying): the server checks each again. */
export async function unfinishedPurchases(): Promise<{ sku: string; token: string }[]> {
  const play = await service();
  if (!play) return [];
  try {
    return (await play.listPurchases()).map((p) => ({ sku: p.itemId, token: p.purchaseToken }));
  } catch {
    return [];
  }
}
