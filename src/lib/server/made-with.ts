import { one, run } from "./db.ts";
import { isAdmin, type User } from "./auth.ts";
import { activeSubscription } from "./subscriptions.ts";
import { domainsForSite } from "./domains.ts";
import { sitePreview } from "../site-preview.ts";
import { english, type Translate } from "../i18n.ts";

/*
 * "Made with Flash ∞ AI" on a published app's link preview: the line at the foot of the picture Flash
 * draws for an app with no picture of its own (see /p/[slug]/card), and "Made with Flash" as the title
 * of a page with none (see site-preview.ts). The published page itself never shows it. Apps on the free
 * plan keep it, which tells the people a link is shared with about Flash. On a paid plan the owner can
 * turn it off for each app. The plan is checked each time a preview is made, so it comes back when the
 * plan ends, and comes off again if the owner picks a plan again.
 */

type Owner = Pick<User, "id" | "email" | "verified_at">;
// What a link preview reads from an app's row, and what the search check read in its page (seo, for
// its main address, with the version it's about).
type PreviewSite = { slug: string; title: string; html: string; user_id: string; made_with: number; seo: string | null; updated_at: number };

/** Whether the user's plan lets them turn it off: a paid plan, as for custom domains and selling. */
export async function canHideMadeWith(user: Owner): Promise<boolean> {
  return isAdmin(user) || Boolean(await activeSubscription(user.id));
}

/** Whether an app's link preview says it now: always, unless its owner turned it off and is on a paid plan. */
export async function showsMadeWith(site: Pick<PreviewSite, "user_id" | "made_with">): Promise<boolean> {
  if (Number(site.made_with)) return true;
  const owner = await one<Owner>("SELECT id, email, verified_at FROM users WHERE id = ?", [site.user_id]);
  return !owner || !(await canHideMadeWith(owner));
}

/** The title of an app whose page has none, once "Made with Flash" is off: the app's own name. */
export const plainTitle = (site: Pick<PreviewSite, "slug" | "title">) => site.title.trim() || site.slug;

/** An app's row, with what its link preview needs. */
export const previewSite = (slug: string) =>
  one<PreviewSite>("SELECT slug, title, html, user_id, made_with, seo, updated_at FROM sites WHERE slug = ?", [slug]);

// madeWith: the foot of the picture says "Made with Flash ∞ AI". Otherwise it shows address, the
// app's own domain, or nothing when it has none.
export type ShareCard = { title: string; description: string; madeWith: boolean; address: string };

/** What the picture shared with an app's link shows. null when there's no such app. */
export async function shareCard(slug: string): Promise<ShareCard | null> {
  const site = await previewSite(slug);
  if (!site) return null;
  const madeWith = await showsMadeWith(site);
  const { title, description } = sitePreview(site.html, madeWith ? undefined : plainTitle(site));
  // A site on both yourbakery.com and www.yourbakery.com shows the shorter one.
  const domains = madeWith ? [] : await domainsForSite(slug);
  return { title, description, madeWith, address: domains.find((d) => !d.startsWith("www.")) ?? domains[0] ?? "" };
}

// on: what the owner chose. allowed: their plan lets them turn it off. shown: link previews say it now.
export type MadeWith = { on: boolean; allowed: boolean; shown: boolean };

/** The setting for one of the user's apps (null when it isn't theirs). */
export async function madeWithFor(user: Owner, slug: string): Promise<MadeWith | null> {
  const site = await one<{ made_with: number }>("SELECT made_with FROM sites WHERE slug = ? AND user_id = ?", [slug, user.id]);
  if (!site) return null;
  const on = Boolean(Number(site.made_with));
  const allowed = await canHideMadeWith(user);
  return { on, allowed, shown: on || !allowed };
}

/** The owner turns it on or off for one of their apps. Only on a paid plan. */
export async function setMadeWith(user: Owner, slug: string, on: boolean, t: Translate = english): Promise<MadeWith | { error: string; status: number }> {
  if (!(await canHideMadeWith(user))) return { error: t("Paid plans can turn this off."), status: 402 };
  await run("UPDATE sites SET made_with = ? WHERE slug = ? AND user_id = ?", [on ? 1 : 0, slug, user.id]);
  return (await madeWithFor(user, slug)) ?? { error: t("Not found"), status: 404 };
}
