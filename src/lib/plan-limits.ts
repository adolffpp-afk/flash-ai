/*
 * How many apps each plan publishes, and how many people a day its apps count (see server/sites.ts
 * and server/visits.ts). Set by Flash's plans so that even the worst case (every app full, every
 * credit used, yearly billing) can't make a plan lose money. Safe in the browser, where the upsells
 * name them.
 */

/**
 * Published apps are public pages on Flash's domain, so publishing is limited to slow abuse: a free
 * account publishes up to 20, and paid plans more. A team member's apps count against their own
 * plan, as their domains and storage do.
 */
export const FREE_SITES = 20;
export const PLAN_SITES: Record<string, number> = { lite: 25, pro: 60, power: 120, max: 300, business: 150, agency: 500 };

/**
 * People counted each UTC day across all of one owner's apps. Past it the apps work as before and
 * views still count, but new people that day aren't counted, so their forms, sign-ups and checkouts
 * show as not matched. A team member's apps count against the member's own plan.
 */
export const FREE_PEOPLE_PER_DAY = 1_000;
/**
 * The app steps (flashDB.track) counted each UTC day across all of one owner's apps on the free plan:
 * a tenth of its people. A paid plan's are its number of people (PLAN_PEOPLE).
 */
export const FREE_STEPS_PER_DAY = FREE_PEOPLE_PER_DAY / 10;
export const PLAN_PEOPLE: Record<string, number> = {
  lite: 20_000,
  pro: 50_000,
  power: 100_000,
  business: 150_000,
  max: 300_000,
  agency: 500_000,
};
