import { creditsFor } from "./credits.ts";

/*
 * What texts, calls, phone numbers and bulk email cost, for the business tools people build with
 * Flash (texting, call tracking, email campaigns). Each one costs Flash money every time it is used,
 * so each is charged in credits at MARKUP times its cost, like AI requests, and a country without a
 * price here can't be texted or called at all.
 *
 * Twilio prices in US cents, checked on 2026-10-16 (twilio.com/en-us/sms/pricing/us and /ca,
 * twilio.com/en-us/voice/pricing/us). Each text is priced at Twilio's rate plus the dearest
 * carrier fee in that country, plus Twilio's 0.1¢ fee for a failed message, sent or received.
 * Update these when Twilio changes its prices.
 */
const FAILED_FEE_CENTS = 0.1;

type TextPrices = {
  // One SMS segment (160 plain characters, or 70 with emoji or non-Latin letters).
  smsCents: number;
  // One picture message.
  mmsCents: number;
};

export const TEXT_PRICES: Record<string, TextPrices> = {
  // $0.0083 a segment, carrier fees up to $0.005 (Verizon); MMS $0.022, carrier fees up to $0.01.
  US: { smsCents: 0.83 + 0.5 + FAILED_FEE_CENTS, mmsCents: 2.2 + 1 + FAILED_FEE_CENTS },
  // $0.0083 a segment, carrier fees up to $0.0087 (Bell); MMS $0.022, carrier fees up to $0.0323 (Bell).
  CA: { smsCents: 0.83 + 0.87 + FAILED_FEE_CENTS, mmsCents: 2.2 + 3.23 + FAILED_FEE_CENTS },
};

/** Credits for one text to or from a phone in this country (ISO code), or null where Flash can't text. */
export function textCredits(country: string, picture = false): number | null {
  const prices = Object.hasOwn(TEXT_PRICES, country) ? TEXT_PRICES[country] : undefined;
  if (!prices) return null;
  return creditsFor(picture ? prices.mmsCents : prices.smsCents);
}

/** How many segments a text is sent as: 160 plain characters each (153 when split), 70 (67 when split) otherwise. */
export function textSegments(text: string): number {
  const chars = [...text];
  // GSM-7, the plain alphabet a segment of 160 holds. Anything else makes the whole text UCS-2.
  const plain = chars.every((c) => /^[A-Za-z0-9 @£$¥èéùìòÇ\n\rØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]$/.test(c));
  const [one, many] = plain ? [160, 153] : [70, 67];
  return chars.length <= one ? 1 : Math.ceil(chars.length / many);
}

/*
 * Phone numbers are rented by the month: $1.15 for a local number, $2.15 for a toll-free one.
 * Their credits are taken each month the number is kept.
 */
export const NUMBER_MONTHLY_CENTS = { local: 115, tollFree: 215 } as const;
export const numberMonthlyCredits = (kind: keyof typeof NUMBER_MONTHLY_CENTS) => creditsFor(NUMBER_MONTHLY_CENTS[kind]);

/*
 * Calls, per started minute: $0.014 to call out, $0.0085 for a call to a local number and $0.022
 * to a toll-free one. Recording adds $0.0025 a minute, and keeping it a month $0.0005.
 */
export const CALL_MINUTE_CENTS = { outbound: 1.4, inboundLocal: 0.85, inboundTollFree: 2.2 } as const;
const RECORDING_MINUTE_CENTS = 0.25 + 0.05;

/** Credits for a call of this many seconds, billed per started minute as Twilio does. */
export function callCredits(kind: keyof typeof CALL_MINUTE_CENTS, seconds: number, recorded = false): number {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return creditsFor(minutes * (CALL_MINUTE_CENTS[kind] + (recorded ? RECORDING_MINUTE_CENTS : 0)));
}

/*
 * Bulk email through Resend, at its pay-as-you-go rate of $0.90 per 1,000 emails beyond a plan's
 * allowance (the dearest rate it lists): about 1 credit for every 4 emails.
 */
export const EMAIL_CENTS = 0.09;
export const emailCredits = (emails: number) => (emails > 0 ? creditsFor(emails * EMAIL_CENTS) : 0);
