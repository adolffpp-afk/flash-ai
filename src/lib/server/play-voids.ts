import { PLAY_PACKS } from "../credits.ts";
import { clawBack, findPurchase, recordReversal } from "./credits.ts";
import { playBillingConfigured, voidedSince } from "./play-billing.ts";

/*
 * Play purchases Google has taken back (a refund, a chargeback, a cancelled order) take their credits
 * back, as a dispute does (see clawBack): credits already spent leave the balance below 0, a debt, so
 * buying a pack and refunding it after spending the credits never costs Flash. Run every hour; each order
 * is taken back once (its ref is unique), so looking at the same days again changes nothing.
 */
const LOOK_BACK_MS = 3 * 86_400_000;

export async function takeBackVoidedPlayPurchases(): Promise<number> {
  if (!playBillingConfigured()) return 0;
  let taken = 0;
  for (const v of await voidedSince(Date.now() - LOOK_BACK_MS)) {
    const purchase = (await findPurchase({ ref: `play:${v.orderId}` })) ?? (await findPurchase({ ref: `play-test:${v.orderId}` }));
    if (!purchase) continue;
    const ref = `play-void:${v.orderId}`;
    const play = PLAY_PACKS.find((p) => p.id === purchase.pack);
    await recordReversal(purchase, "refund", v.orderId, play?.priceCents ?? 0, ref);
    if ((await clawBack(purchase, 1, v.orderId, ref, "Google Play refund", true)) > 0) taken++;
  }
  return taken;
}
