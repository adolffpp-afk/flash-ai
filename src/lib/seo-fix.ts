import { scanPage } from "./seo-scan.ts";
import { evaluate, stillToFix, type CheckId, type SeoContext } from "./seo-rules.ts";
import { fixMessage } from "./seo-words.ts";
import type { Translate } from "./i18n.ts";

/**
 * What a change the search check asked for (Fix it, Fix all, Add it) sends for one copy of the app,
 * the chat's newest, which is the one the builder changes: the message for what that copy still needs
 * of ids, as many as fit (sent, and how many more were asked for: left), or null when it needs none of
 * them. The panel lists its sent before Send, and Send sends exactly that, so what the owner is shown
 * is what is asked for and charged. Kept out of the chat's own code until it's used (see Flash.tsx).
 */
export function fixForCopy(
  t: Translate & { locale?: string },
  html: string,
  ctx: SeoContext,
  ids: CheckId[],
  site: { title: string; address: string },
): { content: string; context: string; sent: CheckId[]; left: number } | null {
  const report = evaluate(scanPage(html), ctx);
  const still = stillToFix(report, ids);
  return still.length ? fixMessage(t, report, still, site) : null;
}
