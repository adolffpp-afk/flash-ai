/*
 * A social post pack: one post each for Instagram, TikTok and Facebook (caption and hashtags),
 * one picture made square and tall, and a short video when asked. Claude writes the posts and
 * the picture and video prompts as JSON; this file reads that JSON and turns posts into text.
 */

export const PLATFORMS = ["Instagram", "TikTok", "Facebook"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Post = { platform: Platform; caption: string; hashtags: string[] };
export type Pack = { posts: Post[]; picture: string; motion: string };

// Hashtags that work best on each network (Instagram allows 30, but a dozen or so reads better).
export const HASHTAG_LIMITS: Record<Platform, number> = { Instagram: 15, TikTok: 5, Facebook: 3 };
// Instagram's limit for a caption with its hashtags; TikTok and Facebook allow more, so all three fit.
export const MAX_POST_CHARS = 2200;

/** "#Golden Crumb!" becomes "#GoldenCrumb"; anything that can't be a hashtag becomes "". */
export function cleanHashtag(tag: unknown): string {
  if (typeof tag !== "string") return "";
  const word = tag.replace(/^[#＃\s]+/, "").replace(/[^\p{L}\p{N}\p{M}_]/gu, "").slice(0, 40);
  // A hashtag of only digits isn't one on any of the three networks.
  return word && !/^\d+$/.test(word) ? `#${word}` : "";
}

const platformOf = (name: unknown): Platform | null => {
  const key = typeof name === "string" ? name.toLowerCase().replace(/[^a-z]/g, "") : "";
  if (key === "instagram" || key === "insta" || key === "ig") return "Instagram";
  if (key === "tiktok") return "TikTok";
  if (key === "facebook" || key === "fb") return "Facebook";
  return null;
};

/** One post as the user will paste it: the caption, a blank line, then the hashtags. */
export function postText(post: Post): string {
  return post.hashtags.length ? `${post.caption}\n\n${post.hashtags.join(" ")}` : post.caption;
}

/** A post with tidy hashtags (no repeats, the network's limit) and a caption cut to fit with them. */
function cleanPost(platform: Platform, raw: Record<string, unknown>): Post | null {
  const caption = typeof raw.caption === "string" ? raw.caption.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!caption) return null;
  const list = Array.isArray(raw.hashtags) ? raw.hashtags : typeof raw.hashtags === "string" ? raw.hashtags.split(/[\s,]+/) : [];
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const tag of list.map(cleanHashtag)) {
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    hashtags.push(tag);
  }
  const tags = hashtags.slice(0, HASHTAG_LIMITS[platform]);
  const room = MAX_POST_CHARS - (tags.length ? tags.join(" ").length + 2 : 0);
  const chars = [...caption];
  return { platform, caption: chars.length > room ? chars.slice(0, room - 1).join("").trimEnd() + "…" : caption, hashtags: tags };
}

/** Reads the writer's JSON (which may come wrapped in a code fence or a sentence). Null when there are no posts in it. */
export function parsePack(text: string): Pack | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const raw = Array.isArray(data.posts) ? (data.posts as unknown[]) : [];
  const posts: Post[] = [];
  for (const platform of PLATFORMS) {
    const found = raw.find((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object" && platformOf((p as Record<string, unknown>).platform) === platform);
    const post = found && cleanPost(platform, found);
    if (post) posts.push(post);
  }
  if (!posts.length) return null;
  const words = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return { posts, picture: words(data.picture, 1500), motion: words(data.motion, 600) };
}

/** A caption's own line breaks, kept when the answer is shown as Markdown. */
const keepLines = (text: string) => text.replace(/\n(?!\n)/g, "  \n");

/** The posts as the answer's text: one section per network, with its hashtags. */
export function packMarkdown(posts: Post[]): string {
  return posts
    .map((p) => `### ${p.platform}\n\n${keepLines(p.caption)}` + (p.hashtags.length ? `\n\n${p.hashtags.join(" ")}` : ""))
    .join("\n\n");
}
