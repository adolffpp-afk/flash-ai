import { creditsFor } from "./credits.ts";
import { msg } from "./i18n.ts";

/*
 * The Social hub: the user's own accounts on the quick social networks, connected to Flash directly
 * (no go-between), with posting, scheduling and one inbox of comments, replies, mentions, messages
 * and reviews, all kept in Flash's own database so the customer owns them (see server/social.ts).
 * This file is safe for the browser: the networks, their limits and the shapes the page and the
 * server share. Tokens never come here.
 *
 * X, YouTube, Google Business Profile and Pinterest sign in through Flash's own app at each (OAuth,
 * see server/social-signin.ts); Bluesky, Mastodon and Telegram take a key the user makes there (an
 * app password, an access token, a bot token). Meta, TikTok and LinkedIn aren't here: they need
 * approvals Flash doesn't have yet.
 */

export type NetworkId = "x" | "youtube" | "google-business" | "pinterest" | "bluesky" | "mastodon" | "telegram";

export type Network = {
  id: NetworkId;
  name: string;
  // signin: Flash's own app at the network (OAuth); key: the user pastes what they made there.
  connect: "signin" | "key";
  // The most characters a post may have (X counts each link as 23).
  maxText: number;
  // What a post there must carry: YouTube takes only videos, Pinterest only pictures.
  needs?: "picture" | "video";
  // What a post there may carry besides words.
  media: ("picture" | "video")[];
  // A title is asked for (YouTube's video title, a Pin's title).
  title?: number;
  // One line on what Flash does there, marked msg() and shown with t().
  blurb: string;
  // The tile's colour and letter: Flash draws no logos.
  color: string;
  // Every post or reply there costs Flash money (X's API), so it is charged in credits.
  paid?: boolean;
};

export const NETWORKS: Network[] = [
  {
    id: "x",
    name: "X",
    connect: "signin",
    maxText: 280,
    media: ["picture"],
    blurb: msg("Post, schedule and answer replies and mentions."),
    color: "#111111",
    paid: true,
  },
  {
    id: "youtube",
    name: "YouTube",
    connect: "signin",
    maxText: 5000,
    needs: "video",
    media: ["video"],
    title: 100,
    blurb: msg("Upload videos and Shorts, and answer comments."),
    color: "#ff0033",
  },
  {
    id: "google-business",
    name: "Google Business Profile",
    connect: "signin",
    maxText: 1500,
    media: [],
    blurb: msg("Post updates to your business on Google, and answer reviews."),
    color: "#1a73e8",
  },
  {
    id: "pinterest",
    name: "Pinterest",
    connect: "signin",
    maxText: 500,
    needs: "picture",
    media: ["picture"],
    title: 100,
    blurb: msg("Pin pictures to your boards, with a link."),
    color: "#e60023",
  },
  {
    id: "bluesky",
    name: "Bluesky",
    connect: "key",
    maxText: 300,
    media: ["picture"],
    blurb: msg("Post, schedule and answer replies and mentions."),
    color: "#1185fe",
  },
  {
    id: "mastodon",
    name: "Mastodon",
    connect: "key",
    maxText: 500,
    media: ["picture"],
    blurb: msg("Post, schedule and answer mentions, on any server."),
    color: "#6364ff",
  },
  {
    id: "telegram",
    name: "Telegram",
    connect: "key",
    maxText: 4096,
    media: ["picture", "video"],
    blurb: msg("Post to your channel or group with your bot, and answer messages."),
    color: "#229ed9",
  },
];

export const networkById = (id: string): Network | undefined => NETWORKS.find((n) => n.id === id);
export const isNetworkId = (id: unknown): id is NetworkId => typeof id === "string" && NETWORKS.some((n) => n.id === id);

// A caption on a Telegram picture or video is at most 1024 characters.
export const TELEGRAM_CAPTION = 1024;
// The most accounts a user keeps here, posts waiting at once, and how far ahead one can be planned.
export const MAX_SOCIAL_ACCOUNTS = 20;
export const MAX_SCHEDULED = 200;
export const MAX_AHEAD_MS = 366 * 86_400_000;

// A link the way X finds one: an address, or a name with a dot and a known ending, like flash-app.dev.
const LINK = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|dev|io|ai|app|co|me|ca|uk|us|info|biz|shop|store|xyz|ly|gl|gg|tv|to|link)\b(?:\/\S*)?/gi;

/** Whether text holds a link, as X counts one (X bills a post with a link at its own price). */
export const hasLink = (text: string) => new RegExp(LINK.source, LINK.flags).test(text);

/** How long a post is on a network: characters, with each link counted as 23 on X. */
export function textLength(network: NetworkId, text: string): number {
  if (network === "x") return [...text.replace(new RegExp(LINK.source, LINK.flags), "x".repeat(23))].length;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) return [...new Intl.Segmenter().segment(text)].length;
  return [...text].length;
}

/*
 * X's pay-per-use API, in US cents, checked on 2026-10-23 (X's developer price list): a post 1.5¢, a
 * post with a link 20¢, each post read 0.5¢ and each user read 1¢ (a mention comes with its author).
 * A reply is a post. Charged at MARKUP times that, before X is asked, so X is never paid for with
 * Flash's money. Update these when X changes them.
 */
export const X_PRICES = { postCents: 1.5, linkPostCents: 20, readCents: 0.5, userReadCents: 1 } as const;
export const X_MENTIONS_PAGE = 10;

/** Credits for one post or reply on X. */
export const xPostCredits = (text: string) => creditsFor(hasLink(text) ? X_PRICES.linkPostCents : X_PRICES.postCents);
/** Credits for reading this many X mentions, each with its author. */
export const xReadCredits = (mentions: number) => (mentions > 0 ? creditsFor((X_PRICES.readCents + X_PRICES.userReadCents) * mentions) : 0);
/** Credits held for one check of X mentions: the most it can read. */
export const xMentionsCredits = () => xReadCredits(X_MENTIONS_PAGE);

/** A connected account as the page shows it: never a token. */
export type SocialAccountView = {
  id: string;
  network: NetworkId;
  // Its handle, channel or page name, as the network says it.
  name: string;
  status: "ok" | "needs_reconnect";
  // Where posts go, when the network has several: Pinterest boards, Google Business locations.
  targets: { id: string; name: string }[];
  target: string;
  createdAt: number;
};

export type DeliveryStatus = "waiting" | "posting" | "done" | "failed" | "cancelled";

export type SocialPostView = {
  id: string;
  text: string;
  title: string;
  link: string;
  fileId: string;
  fileName: string;
  // When it goes out (or went out).
  at: number;
  createdAt: number;
  deliveries: {
    accountId: string;
    network: NetworkId;
    name: string;
    status: DeliveryStatus;
    // The post on the network, once it is there.
    url: string;
    problem: string;
    credits: number;
  }[];
};

export type InboxKind = "comment" | "reply" | "mention" | "message" | "review";

export type InboxItemView = {
  id: string;
  accountId: string;
  network: NetworkId;
  kind: InboxKind;
  author: string;
  text: string;
  // Where to see it on the network (only on the network's own site).
  url: string;
  // Google reviews: 1 to 5 stars.
  stars: number;
  at: number;
  repliedAt: number;
  reply: string;
};

/** What a key-connected account needs, by network, as the form asks it. */
export type KeyConnect =
  | { network: "bluesky"; handle: string; password: string }
  | { network: "mastodon"; server: string; token: string }
  | { network: "telegram"; token: string; chat: string };

/** The kinds of inbox items, as the page names them. */
export const KIND_WORDS: Record<InboxKind, string> = {
  comment: msg("Comment"),
  reply: msg("Reply"),
  mention: msg("Mention"),
  message: msg("Message"),
  review: msg("Review"),
};
