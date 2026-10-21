import { msg, type Translate } from "./i18n.ts";

/* The "Made with Flash" showcase's shapes, shared by the server (server/showcase.ts) and the landing page. */

export type ShowcaseKind = "site" | "picture";
// waiting: offered by its owner, not yet approved. shown: on the landing page. hidden: turned down.
export type ShowcaseStatus = "waiting" | "shown" | "hidden";

/** What became of an app or picture its owner offered for the showcase, said to them. */
export const showcaseLabel = (status: ShowcaseStatus | null, t: Translate) =>
  status === "shown" ? t("On Flash's home page") : status === "hidden" ? t("Not chosen for now") : status === "waiting" ? t("Waiting for approval") : t("Off");

export type ShowcaseList = {
  sites: { slug: string; title: string }[];
  pictures: { id: string; title: string }[];
};

/*
 * Examples of what Flash builds, each drawn on the page as a screenshot of it (see ShowcaseMockups.tsx),
 * so the showcase is never empty. They are marked "Example" where they show, or "Coming soon" for what
 * Flash can't build yet (soon), and step aside as approved apps take their places.
 */
export type ShowcaseExample = {
  // Which screenshot is drawn for it.
  id: "booking" | "shop" | "phone" | "callcentre" | "automation" | "dashboard";
  title: string;
  kind: string;
  prompt: string;
  soon?: boolean;
};

export const SHOWCASE_EXAMPLES: ShowcaseExample[] = [
  { id: "booking", title: "Elaia Hair Studio", kind: "Booking website", prompt: "A booking page for my hair salon in Toronto" },
  { id: "phone", title: "Stride", kind: "Mobile app", prompt: "A phone app to log my runs and see my weekly progress" },
  { id: "shop", title: "Golden Crumb Bakery", kind: "Online shop", prompt: "A shop for my bakery that takes orders for pickup" },
  {
    id: "callcentre",
    title: "Northwind Support",
    kind: "Call centre",
    prompt: "A call centre where AI answers customers and hands hard calls to my team",
    soon: true,
  },
  {
    id: "automation",
    title: "Order follow-up",
    kind: "Automation",
    prompt: "When someone orders, text them a thank-you and add the order to my sheet",
    soon: true,
  },
  { id: "dashboard", title: "Kora Sales", kind: "Business dashboard", prompt: "A dashboard of this month's sales by product and city" },
];

/* Requests typed out, one after another, in the empty message box on Home and the landing page (see use-typing.ts). */
export const TYPED_IDEAS = [
  msg("I want a booking website for my hair salon in Toronto"),
  msg("Make an online shop for my bakery that takes pickup orders"),
  msg("Build a phone app to log my runs and show my weekly progress"),
  msg("Create a dashboard of this month's sales by product and city"),
  msg("Make a habit tracker that reminds me to drink water"),
];
