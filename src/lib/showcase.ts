import type { Translate } from "./i18n.ts";

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
 * Examples of what Flash builds, drawn on the page itself, so the showcase is never empty. They are
 * marked "Example" where they show, and step aside as approved apps take their places.
 */
export type ShowcaseExample = {
  title: string;
  kind: string;
  prompt: string;
  // The little page drawn on the card: its colours, heading and three items.
  from: string;
  to: string;
  heading: string;
  items: string[];
  button: string;
};

export const SHOWCASE_EXAMPLES: ShowcaseExample[] = [
  {
    title: "Elaia Hair Studio",
    kind: "Booking page",
    prompt: "A booking page for my hair salon in Toronto",
    from: "from-rose-100",
    to: "to-amber-50",
    heading: "Book your next appointment",
    items: ["Braids · 2h", "Cut · 45m", "Colour · 1h30"],
    button: "Book",
  },
  {
    title: "Golden Crumb Bakery",
    kind: "Online shop",
    prompt: "A shop for my bakery that takes orders for pickup",
    from: "from-amber-100",
    to: "to-orange-50",
    heading: "Fresh every morning",
    items: ["Sourdough $8", "Croissant $4", "Cake $35"],
    button: "Order",
  },
  {
    title: "Stride",
    kind: "Workout tracker app",
    prompt: "An app to log my runs and see my weekly progress",
    from: "from-emerald-100",
    to: "to-cyan-50",
    heading: "This week: 18.4 km",
    items: ["Mon 5 km", "Wed 6.2 km", "Sat 7.2 km"],
    button: "Log run",
  },
  {
    title: "Maya Okafor",
    kind: "Portfolio website",
    prompt: "A portfolio site for my photography with a contact form",
    from: "from-violet-100",
    to: "to-sky-50",
    heading: "Portraits & weddings",
    items: ["Gallery", "Prices", "About"],
    button: "Contact",
  },
  {
    title: "Kitchen Count",
    kind: "Inventory app",
    prompt: "An app for my restaurant to count stock and warn when it runs low",
    from: "from-sky-100",
    to: "to-indigo-50",
    heading: "3 items running low",
    items: ["Rice 4 kg", "Oil 2 L", "Eggs 30"],
    button: "Reorder",
  },
  {
    title: "Northside FC",
    kind: "Club website",
    prompt: "A website for our kids' football club with sign-ups and fixtures",
    from: "from-lime-100",
    to: "to-emerald-50",
    heading: "Next match: Saturday 10:00",
    items: ["Fixtures", "Teams", "Join"],
    button: "Sign up",
  },
];
