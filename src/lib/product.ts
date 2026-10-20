import { msg } from "./i18n.ts";

/*
 * Flash's own names, in one place. None of them is translated.
 *  - PRODUCT_NAME, "Flash ∞ AI": the header, titles, the installed app's name, share cards and emails.
 *  - BRAND_NAME, "Flash Infinity AI": the full name, as screen readers read the wordmark (see Wordmark
 *    in src/app/brand.tsx) and as emails are signed.
 *  - LEGAL_NAME, "AI-Flash Inc.": the company that runs Flash, named in the footer, the terms and the
 *    privacy policy.
 *  - TRADEMARK, "Flash Infinity AI™": the trademark AI-Flash Inc. has applied for, named in the footers.
 *    The prominent wordmarks (landing header, sidebar, sign-in, legal pages) carry a small ™ too.
 * Internal names (the package, cookies, the connector's "flash-ai") stay as they are.
 */
export const PRODUCT_NAME = "Flash ∞ AI";
export const BRAND_NAME = "Flash Infinity AI";
export const LEGAL_NAME = "AI-Flash Inc.";
/** The name as filed for trademark by AI-Flash Inc.: ™ while the application is pending (® only once registered). */
export const TRADEMARK = `${BRAND_NAME}™`;
/** Where people write for help: shown in the footer, the account menu, Settings, the legal pages and emails. Mail to it forwards to the owner. */
export const SUPPORT_EMAIL = "support@flash-app.dev";

/** The marketing line, under the name: the landing page's headline, the sidebar and the share card. */
export const TAGLINE = msg("One Workspace. Infinite Possibilities.");
