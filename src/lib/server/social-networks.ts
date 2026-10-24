import { randomBytes } from "node:crypto";
import { msg } from "../i18n.ts";
import type { InboxKind, NetworkId } from "../social.ts";
import { SafeFetchError, safeFetch, type SafeRequest, type SafeResponse } from "./safe-fetch.ts";
import { GRAPH_VERSION, bodyOf, socialHost } from "./social-signin.ts";

/*
 * Each network's own API, called with the user's own token (see social.ts, which keeps the tokens
 * and decides when to call): who the account is, posting (words, a picture or a video), the inbox
 * (comments, replies, mentions, messages, reviews) and replying. Every request goes through
 * safeFetch (Mastodon's server is one the user names). Nothing the network answers is ever shown
 * as Flash's own words: a problem is one of Flash's fixed phrases, and the network's text stays out
 * of logs.
 */

/** Why a call didn't do what was asked. "unknown": the network may have done it (a timeout after sending), so it is never tried again by itself. */
export type SocialProblemCode = "auth" | "refused" | "limit" | "unreachable" | "unknown" | "too_large" | "bad_input";

export class SocialError extends Error {
  code: SocialProblemCode;
  // A short note of where it went wrong (a step and the network's error number), for the log and the owners.
  detail: string;
  constructor(code: SocialProblemCode, message: string, detail = "") {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export const PROBLEMS: Record<SocialProblemCode, string> = {
  auth: msg("The network refused Flash's access. Connect this account again."),
  refused: msg("The network refused this post."),
  limit: msg("The network says too many posts were sent. Try again later."),
  unreachable: msg("The network couldn't be reached. Nothing was posted."),
  unknown: msg("The network didn't answer in time. Check the account before posting it again."),
  too_large: msg("The file is too large for this network."),
  bad_input: msg("This post doesn't fit this network."),
};

/** What a connected account calls with. */
export type Ctx = {
  network: NetworkId;
  // The access token (Telegram: the bot's token).
  token: string;
  // The network's id for the account (X's user id, Bluesky's DID, Mastodon's account id, a channel).
  accountId: string;
  // Mastodon: the server's origin. Telegram: the channel's public address, if it has one.
  server: string;
  // Where posts go, when the network has several (a board, a location, a Telegram chat).
  target: string;
  signal?: AbortSignal;
};

export type Media = { mime: string; name: string; data: Buffer };
// mediaUrl: a short-lived public address for the media, for networks that fetch it themselves (Instagram, Threads).
export type Outgoing = { text: string; title: string; link: string; media: Media | null; mediaUrl?: string; idempotencyKey: string };
export type Posted = { remoteId: string; url: string };
// secret: what to keep sealed for the account besides its tokens (Facebook: each Page's own token).
export type Found = { accountId: string; name: string; targets: { id: string; name: string }[]; server?: string; secret?: string };
export type InboxIn = { remoteId: string; kind: InboxKind; author: string; text: string; url: string; stars: number; at: number; ref: Record<string, string> };

const API_MS = 20_000;
const UPLOAD_MS = 240_000;
const oneLine = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const textOf = (value: unknown, max = 4000) =>
  String(value ?? "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f‪-‮⁦-⁩]+/g, "")
    .trim()
    .slice(0, max);
const ID = /^[\w:.@/-]{1,200}$/;
const idOf = (value: unknown) => (typeof value === "string" || typeof value === "number") && ID.test(String(value)) ? String(value) : "";
const timeOf = (value: unknown) => {
  const t = typeof value === "number" ? value * 1000 : Date.parse(String(value ?? ""));
  return Number.isFinite(t) && t > 0 ? t : Date.now();
};

type Call = Omit<SafeRequest, "accept" | "body"> & { token?: string; json?: unknown; form?: Record<string, string>; body?: string | Buffer; type?: string; write?: boolean };

/** One request to a network, its answer read as JSON. A write that may have reached the network but got no answer is "unknown". */
async function call(url: string, c: Call = {}): Promise<{ status: number; body: Record<string, unknown>; raw: SafeResponse }> {
  const headers: Record<string, string> = { accept: "application/json", ...c.headers };
  if (c.token) headers.authorization = `Bearer ${c.token}`;
  let body = c.body;
  if (c.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(c.json);
  } else if (c.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(c.form).toString();
  } else if (c.type) headers["content-type"] = c.type;
  let raw: SafeResponse;
  try {
    raw = await safeFetch(url, { method: c.method ?? (body !== undefined ? "POST" : "GET"), headers, body, accept: ["json"], maxBytes: c.maxBytes ?? 2 * 1024 * 1024, timeoutMs: c.timeoutMs ?? API_MS, signal: c.signal, followRedirects: false });
  } catch (err) {
    if (err instanceof SafeFetchError && (err.code === "blocked" || err.code === "redirects")) throw new SocialError("bad_input", PROBLEMS.bad_input);
    if (c.write && !(err instanceof SafeFetchError && err.code === "network")) throw new SocialError("unknown", PROBLEMS.unknown);
    throw new SocialError("unreachable", PROBLEMS.unreachable);
  }
  return { status: raw.status, body: bodyOf(raw), raw };
}

/** Throws for an answer that isn't a success: 401 (and Google's 403 for a grant taken back) need Reconnect. */
function ok(res: { status: number; body: Record<string, unknown> }, write = false) {
  if (res.status >= 200 && res.status < 300) return;
  if (res.status === 401) throw new SocialError("auth", PROBLEMS.auth);
  if (res.status === 429) throw new SocialError("limit", PROBLEMS.limit);
  if (res.status === 413) throw new SocialError("too_large", PROBLEMS.too_large);
  if (res.status >= 500 && write) throw new SocialError("unknown", PROBLEMS.unknown);
  if (res.status >= 500) throw new SocialError("unreachable", PROBLEMS.unreachable);
  throw new SocialError("refused", PROBLEMS.refused);
}

/** A multipart/form-data body. */
function formData(parts: { name: string; value: string | Buffer; filename?: string; type?: string }[]): { body: Buffer; type: string } {
  const boundary = `flash${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const name = p.name.replace(/[^\w-]/g, "");
    const file = p.filename !== undefined ? `; filename="${p.filename.replace(/[^\w.-]/g, "_").slice(0, 80) || "file"}"` : "";
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`));
    chunks.push(typeof p.value === "string" ? Buffer.from(p.value) : p.value);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

const MB = 1024 * 1024;
/** The largest file each network takes, by kind. */
export const MEDIA_LIMITS: Record<NetworkId, { picture: number; video: number }> = {
  x: { picture: 5 * MB, video: 0 },
  youtube: { picture: 0, video: 256 * MB },
  "google-business": { picture: 0, video: 0 },
  pinterest: { picture: 20 * MB, video: 0 },
  bluesky: { picture: 976 * 1024, video: 0 },
  mastodon: { picture: 16 * MB, video: 0 },
  telegram: { picture: 10 * MB, video: 50 * MB },
  facebook: { picture: 10 * MB, video: 100 * MB },
  instagram: { picture: 8 * MB, video: 100 * MB },
  threads: { picture: 8 * MB, video: 100 * MB },
};
export const PICTURE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
export const VIDEO_TYPES = /^video\/(mp4|quicktime|webm)$/;

// ---------------------------------------------------------------------------------------------- X

const X_API = () => `${socialHost("x", "https://api.x.com")}/2`;

async function xMe(token: string): Promise<Found> {
  const me = await call(`${X_API()}/users/me`, { token });
  ok(me);
  const data = (me.body.data ?? {}) as Record<string, unknown>;
  const id = idOf(data.id);
  if (!id) throw new SocialError("refused", PROBLEMS.refused);
  return { accountId: id, name: `@${oneLine(data.username, 50)}`, targets: [] };
}

async function xPost(ctx: Ctx, out: Outgoing, replyTo = ""): Promise<Posted> {
  let mediaId = "";
  if (out.media) {
    const form = formData([
      { name: "media", value: out.media.data, filename: out.media.name, type: out.media.mime },
      { name: "media_category", value: "tweet_image" },
    ]);
    const up = await call(`${X_API()}/media/upload`, { token: ctx.token, body: form.body, type: form.type, timeoutMs: 60_000, signal: ctx.signal });
    ok(up);
    mediaId = idOf(((up.body.data ?? {}) as Record<string, unknown>).id);
    if (!mediaId) throw new SocialError("refused", PROBLEMS.refused);
  }
  const res = await call(`${X_API()}/tweets`, {
    token: ctx.token,
    json: { text: out.text, ...(mediaId && { media: { media_ids: [mediaId] } }), ...(replyTo && { reply: { in_reply_to_tweet_id: replyTo } }) },
    write: true,
    signal: ctx.signal,
  });
  ok(res, true);
  const id = idOf(((res.body.data ?? {}) as Record<string, unknown>).id);
  if (!id) throw new SocialError("unknown", PROBLEMS.unknown);
  return { remoteId: id, url: `https://x.com/i/web/status/${id}` };
}

async function xMentions(ctx: Ctx, cursor: string): Promise<{ items: InboxIn[]; cursor: string }> {
  const url = new URL(`${X_API()}/users/${encodeURIComponent(ctx.accountId)}/mentions`);
  url.searchParams.set("max_results", "10");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");
  url.searchParams.set("tweet.fields", "created_at");
  if (/^\d{1,30}$/.test(cursor)) url.searchParams.set("since_id", cursor);
  const res = await call(url.href, { token: ctx.token, signal: ctx.signal });
  ok(res);
  const users = new Map<string, string>();
  for (const u of ((res.body.includes as Record<string, unknown> | undefined)?.users ?? []) as Record<string, unknown>[]) users.set(String(u.id), oneLine(u.username, 50));
  const data = (Array.isArray(res.body.data) ? res.body.data : []) as Record<string, unknown>[];
  const items = data.slice(0, 10).flatMap((t) => {
    const id = idOf(t.id);
    if (!/^\d{1,30}$/.test(id)) return [];
    const author = users.get(String(t.author_id)) ?? "";
    return [{ remoteId: id, kind: "mention" as const, author: author ? `@${author}` : "", text: textOf(t.text), url: `https://x.com/i/web/status/${id}`, stars: 0, at: timeOf(t.created_at), ref: { id } }];
  });
  const newest = idOf(((res.body.meta ?? {}) as Record<string, unknown>).newest_id);
  return { items, cursor: /^\d{1,30}$/.test(newest) ? newest : cursor };
}

// ---------------------------------------------------------------------------------------- Google

const YT = () => `${socialHost("youtube", "https://www.googleapis.com")}`;

async function youtubeMe(token: string): Promise<Found> {
  const res = await call(`${YT()}/youtube/v3/channels?part=snippet&mine=true`, { token });
  ok(res);
  const channel = ((res.body.items ?? []) as Record<string, unknown>[])[0];
  const id = idOf(channel?.id);
  if (!id) throw new SocialError("refused", msg("This Google account has no YouTube channel yet. Make one on YouTube, then connect again."));
  return { accountId: id, name: oneLine((channel.snippet as Record<string, unknown> | undefined)?.title, 100), targets: [] };
}

async function youtubeUpload(ctx: Ctx, out: Outgoing): Promise<Posted> {
  if (!out.media || !VIDEO_TYPES.test(out.media.mime)) throw new SocialError("bad_input", PROBLEMS.bad_input);
  const boundary = `flash${randomBytes(12).toString("hex")}`;
  const meta = { snippet: { title: out.title || out.text.slice(0, 100) || out.media.name, description: out.text, categoryId: "22" }, status: { privacyStatus: "public", selfDeclaredMadeForKids: false } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${out.media.mime}\r\n\r\n`),
    out.media.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await call(`${YT()}/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status`, {
    token: ctx.token,
    body,
    type: `multipart/related; boundary=${boundary}`,
    timeoutMs: UPLOAD_MS,
    write: true,
    signal: ctx.signal,
  });
  ok(res, true);
  const id = idOf(res.body.id);
  if (!id) throw new SocialError("unknown", PROBLEMS.unknown);
  return { remoteId: id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` };
}

async function youtubeComments(ctx: Ctx): Promise<{ items: InboxIn[]; cursor: string }> {
  const res = await call(`${YT()}/youtube/v3/commentThreads?part=snippet&order=time&maxResults=50&allThreadsRelatedToChannelId=${encodeURIComponent(ctx.accountId)}`, { token: ctx.token, signal: ctx.signal });
  ok(res);
  const items = ((res.body.items ?? []) as Record<string, unknown>[]).flatMap((thread) => {
    const snippet = (thread.snippet ?? {}) as Record<string, unknown>;
    const top = (snippet.topLevelComment ?? {}) as Record<string, unknown>;
    const c = (top.snippet ?? {}) as Record<string, unknown>;
    const id = idOf(top.id);
    const video = idOf(snippet.videoId);
    if (!id) return [];
    return [{ remoteId: id, kind: "comment" as const, author: oneLine(c.authorDisplayName, 100), text: textOf(c.textOriginal ?? c.textDisplay), url: video ? `https://www.youtube.com/watch?v=${encodeURIComponent(video)}&lc=${encodeURIComponent(id)}` : "", stars: 0, at: timeOf(c.publishedAt), ref: { parent: id } }];
  });
  return { items, cursor: "" };
}

async function youtubeReply(ctx: Ctx, ref: Record<string, string>, text: string): Promise<Posted> {
  const res = await call(`${YT()}/youtube/v3/comments?part=snippet`, { token: ctx.token, json: { snippet: { parentId: ref.parent, textOriginal: text } }, write: true, signal: ctx.signal });
  ok(res, true);
  return { remoteId: idOf(res.body.id), url: "" };
}

const GBP = {
  accounts: () => `${socialHost("google-business", "https://mybusinessaccountmanagement.googleapis.com")}/v1`,
  info: () => `${socialHost("google-business", "https://mybusinessbusinessinformation.googleapis.com")}/v1`,
  v4: () => `${socialHost("google-business", "https://mybusiness.googleapis.com")}/v4`,
};
const LOCATION = /^accounts\/\d{1,30}\/locations\/\d{1,30}$/;

async function businessMe(token: string, sub: string): Promise<Found> {
  const res = await call(`${GBP.accounts()}/accounts?pageSize=20`, { token });
  if (res.status === 403) throw new SocialError("refused", msg("Google hasn't opened its Business Profile API to Flash yet."));
  ok(res);
  const targets: { id: string; name: string }[] = [];
  for (const account of ((res.body.accounts ?? []) as Record<string, unknown>[]).slice(0, 5)) {
    const name = String(account.name ?? "");
    if (!/^accounts\/\d{1,30}$/.test(name)) continue;
    const locs = await call(`${GBP.info()}/${name}/locations?readMask=name,title&pageSize=100`, { token });
    if (locs.status !== 200) continue;
    for (const l of (locs.body.locations ?? []) as Record<string, unknown>[]) {
      const id = `${name}/${String(l.name ?? "")}`;
      if (LOCATION.test(id) && targets.length < 50) targets.push({ id, name: oneLine(l.title, 100) || id });
    }
  }
  if (!targets.length) throw new SocialError("refused", msg("This Google account manages no business on Google yet."));
  return { accountId: sub, name: targets[0].name, targets };
}

async function businessPost(ctx: Ctx, out: Outgoing): Promise<Posted> {
  if (!LOCATION.test(ctx.target)) throw new SocialError("bad_input", PROBLEMS.bad_input);
  const link = /^https:\/\/\S{1,2000}$/.test(out.link) ? out.link : "";
  const res = await call(`${GBP.v4()}/${ctx.target}/localPosts`, {
    token: ctx.token,
    json: { languageCode: "en", summary: out.text, topicType: "STANDARD", ...(link && { callToAction: { actionType: "LEARN_MORE", url: link } }) },
    write: true,
    signal: ctx.signal,
  });
  ok(res, true);
  const search = String(res.body.searchUrl ?? "");
  return { remoteId: oneLine(res.body.name, 300), url: /^https:\/\/(www\.)?google\.[a-z.]+\//.test(search) ? search : "" };
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function businessReviews(ctx: Ctx): Promise<{ items: InboxIn[]; cursor: string }> {
  if (!LOCATION.test(ctx.target)) return { items: [], cursor: "" };
  const res = await call(`${GBP.v4()}/${ctx.target}/reviews?pageSize=50`, { token: ctx.token, signal: ctx.signal });
  ok(res);
  const items = ((res.body.reviews ?? []) as Record<string, unknown>[]).flatMap((r) => {
    const name = String(r.name ?? "");
    if (!/^accounts\/\d{1,30}\/locations\/\d{1,30}\/reviews\/[\w-]{1,200}$/.test(name)) return [];
    return [{ remoteId: name, kind: "review" as const, author: oneLine((r.reviewer as Record<string, unknown> | undefined)?.displayName, 100), text: textOf(r.comment), url: "", stars: STARS[String(r.starRating)] ?? 0, at: timeOf(r.createTime), ref: { review: name } }];
  });
  return { items, cursor: "" };
}

async function businessReply(ctx: Ctx, ref: Record<string, string>, text: string): Promise<Posted> {
  if (!/^accounts\/\d{1,30}\/locations\/\d{1,30}\/reviews\/[\w-]{1,200}$/.test(ref.review ?? "") || !ref.review.startsWith(`${ctx.target}/`)) throw new SocialError("bad_input", PROBLEMS.bad_input);
  const res = await call(`${GBP.v4()}/${ref.review}/reply`, { method: "PUT", token: ctx.token, json: { comment: text }, write: true, signal: ctx.signal });
  ok(res, true);
  return { remoteId: ref.review, url: "" };
}

// ------------------------------------------------------------------------------------- Pinterest

const PIN = () => `${socialHost("pinterest", "https://api.pinterest.com")}/v5`;

async function pinterestMe(token: string): Promise<Found> {
  const me = await call(`${PIN()}/user_account`, { token });
  ok(me);
  const username = oneLine(me.body.username, 60);
  const id = idOf(me.body.id) || idOf(username);
  if (!id) throw new SocialError("refused", PROBLEMS.refused);
  const boards = await call(`${PIN()}/boards?page_size=100`, { token });
  ok(boards);
  const targets = ((boards.body.items ?? []) as Record<string, unknown>[]).flatMap((b) => (/^\d{1,30}$/.test(String(b.id)) ? [{ id: String(b.id), name: oneLine(b.name, 100) }] : [])).slice(0, 100);
  if (!targets.length) throw new SocialError("refused", msg("Make a board on Pinterest first, then connect again."));
  return { accountId: id, name: username, targets };
}

async function pinterestPin(ctx: Ctx, out: Outgoing): Promise<Posted> {
  if (!out.media || !/^image\/(png|jpeg)$/.test(out.media.mime) || !/^\d{1,30}$/.test(ctx.target)) throw new SocialError("bad_input", PROBLEMS.bad_input);
  const link = /^https:\/\/\S{1,2000}$/.test(out.link) ? out.link : "";
  const res = await call(`${PIN()}/pins`, {
    token: ctx.token,
    json: {
      board_id: ctx.target,
      title: out.title.slice(0, 100),
      description: out.text.slice(0, 500),
      ...(link && { link }),
      media_source: { source_type: "image_base64", content_type: out.media.mime, data: out.media.data.toString("base64") },
    },
    timeoutMs: 60_000,
    write: true,
    signal: ctx.signal,
  });
  ok(res, true);
  const id = idOf(res.body.id);
  return { remoteId: id, url: /^\d{1,30}$/.test(id) ? `https://www.pinterest.com/pin/${id}/` : "" };
}

// --------------------------------------------------------------------------------------- Bluesky

const BSKY = () => `${socialHost("bluesky", "https://bsky.social")}/xrpc`;
export const HANDLE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}$/i;
export type BlueskySession = { access: string; refresh: string; expiresAt: number; did: string; handle: string };

const jwtExpiry = (jwt: string) => {
  try {
    const exp = Number((JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown }).exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : Date.now() + 60 * 60_000;
  } catch {
    return Date.now() + 60 * 60_000;
  }
};

function readSession(res: { status: number; body: Record<string, unknown> }): BlueskySession {
  ok(res);
  const access = String(res.body.accessJwt ?? "");
  const refresh = String(res.body.refreshJwt ?? "");
  const did = String(res.body.did ?? "");
  if (!/^[\w.-]{20,8192}$/.test(access) || !/^[\w.-]{20,8192}$/.test(refresh) || !/^did:(plc|web):[\w.:%-]{1,200}$/.test(did)) throw new SocialError("refused", PROBLEMS.refused);
  return { access, refresh, expiresAt: jwtExpiry(access), did, handle: oneLine(res.body.handle, 253) };
}

/** Signs in with the handle and an app password (made in Bluesky's Settings > Privacy and security > App passwords). */
export async function blueskyLogin(handle: string, password: string): Promise<BlueskySession> {
  const res = await call(`${BSKY()}/com.atproto.server.createSession`, { json: { identifier: handle, password } });
  if (res.status === 400 || res.status === 401) throw new SocialError("auth", msg("Bluesky didn't accept that handle and app password."));
  return readSession(res);
}

export async function blueskyRefresh(refresh: string): Promise<BlueskySession> {
  return readSession(await call(`${BSKY()}/com.atproto.server.refreshSession`, { token: refresh, method: "POST" }));
}

/** Links and hashtags as Bluesky marks them (it doesn't find them itself), by their place in the UTF-8 bytes. */
export function blueskyFacets(text: string): Record<string, unknown>[] {
  const enc = new TextEncoder();
  const at = (i: number) => enc.encode(text.slice(0, i)).length;
  const facets: Record<string, unknown>[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'"]/g)) {
    const start = at(m.index!);
    facets.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  for (const m of text.matchAll(/(^|\s)(#[^\s#.,;:!?()[\]"']{1,64})/gu)) {
    const start = at(m.index! + m[1].length);
    facets.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[2]).length }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[2].slice(1) }] });
  }
  return facets;
}

const rkeyOf = (uri: string) => /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([\w~.-]{1,64})$/.exec(uri)?.[1] ?? "";

async function blueskyPost(ctx: Ctx, out: Outgoing, reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } }): Promise<Posted> {
  let embed: Record<string, unknown> | undefined;
  if (out.media) {
    const up = await call(`${BSKY()}/com.atproto.repo.uploadBlob`, { token: ctx.token, body: out.media.data, type: out.media.mime, timeoutMs: 60_000, signal: ctx.signal });
    ok(up);
    if (!up.body.blob || typeof up.body.blob !== "object") throw new SocialError("refused", PROBLEMS.refused);
    embed = { $type: "app.bsky.embed.images", images: [{ image: up.body.blob, alt: out.title || "" }] };
  }
  const facets = blueskyFacets(out.text);
  const record = {
    $type: "app.bsky.feed.post",
    text: out.text,
    createdAt: new Date().toISOString(),
    ...(facets.length && { facets }),
    ...(embed && { embed }),
    ...(reply && { reply }),
  };
  const res = await call(`${BSKY()}/com.atproto.repo.createRecord`, { token: ctx.token, json: { repo: ctx.accountId, collection: "app.bsky.feed.post", record }, write: true, signal: ctx.signal });
  ok(res, true);
  const uri = String(res.body.uri ?? "");
  const rkey = rkeyOf(uri);
  return { remoteId: uri.slice(0, 300), url: rkey ? `https://bsky.app/profile/${encodeURIComponent(ctx.accountId)}/post/${rkey}` : "" };
}

async function blueskyInbox(ctx: Ctx): Promise<{ items: InboxIn[]; cursor: string }> {
  const res = await call(`${BSKY()}/app.bsky.notification.listNotifications?limit=50`, { token: ctx.token, signal: ctx.signal });
  ok(res);
  const items = ((res.body.notifications ?? []) as Record<string, unknown>[]).flatMap((n) => {
    const reason = String(n.reason);
    if (reason !== "reply" && reason !== "mention" && reason !== "quote") return [];
    const uri = String(n.uri ?? "");
    const cid = String(n.cid ?? "");
    if (!rkeyOf(uri) || !/^[\w]{10,120}$/.test(cid)) return [];
    const author = (n.author ?? {}) as Record<string, unknown>;
    const record = (n.record ?? {}) as Record<string, unknown>;
    const root = ((record.reply as Record<string, unknown> | undefined)?.root ?? {}) as Record<string, unknown>;
    const rootUri = rkeyOf(String(root.uri ?? "")) ? String(root.uri) : uri;
    const rootCid = /^[\w]{10,120}$/.test(String(root.cid ?? "")) && rootUri !== uri ? String(root.cid) : cid;
    const handle = oneLine(author.handle, 253);
    return [
      {
        remoteId: uri,
        kind: reason === "reply" ? ("reply" as const) : ("mention" as const),
        author: handle ? `@${handle}` : "",
        text: textOf(record.text),
        url: HANDLE.test(handle) ? `https://bsky.app/profile/${handle}/post/${rkeyOf(uri)}` : "",
        stars: 0,
        at: timeOf(n.indexedAt),
        ref: { uri, cid, rootUri, rootCid },
      },
    ];
  });
  return { items, cursor: "" };
}

// -------------------------------------------------------------------------------------- Mastodon

/** A Mastodon server's origin from what the user typed (mastodon.social, or its whole address). */
export function mastodonServer(value: string): string {
  const text = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.username) return "";
    return url.origin;
  } catch {
    return "";
  }
}

const mastodonApi = (ctx: Pick<Ctx, "server">) => `${socialHost("mastodon", ctx.server)}/api`;

async function mastodonMe(server: string, token: string): Promise<Found> {
  const res = await call(`${mastodonApi({ server })}/v1/accounts/verify_credentials`, { token });
  ok(res);
  const id = idOf(res.body.id);
  if (!id) throw new SocialError("refused", PROBLEMS.refused);
  return { accountId: id, name: `@${oneLine(res.body.acct, 100)}@${new URL(server).hostname}`, targets: [], server };
}

async function mastodonPost(ctx: Ctx, out: Outgoing, replyTo = ""): Promise<Posted> {
  let mediaId = "";
  if (out.media) {
    const form = formData([{ name: "file", value: out.media.data, filename: out.media.name, type: out.media.mime }, ...(out.title ? [{ name: "description", value: out.title }] : [])]);
    const up = await call(`${mastodonApi(ctx)}/v2/media`, { token: ctx.token, body: form.body, type: form.type, timeoutMs: 60_000, signal: ctx.signal });
    ok(up);
    mediaId = idOf(up.body.id);
    if (!mediaId) throw new SocialError("refused", PROBLEMS.refused);
  }
  const res = await call(`${mastodonApi(ctx)}/v1/statuses`, {
    token: ctx.token,
    // Mastodon keeps a post made with the same key for an hour, so a second try never posts twice.
    headers: { "idempotency-key": out.idempotencyKey },
    json: { status: out.text, ...(mediaId && { media_ids: [mediaId] }), ...(replyTo && { in_reply_to_id: replyTo }) },
    write: true,
    signal: ctx.signal,
  });
  ok(res, true);
  const id = idOf(res.body.id);
  const url = String(res.body.url ?? "");
  return { remoteId: id, url: url.startsWith(`${ctx.server}/`) ? url : "" };
}

const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

async function mastodonInbox(ctx: Ctx, cursor: string): Promise<{ items: InboxIn[]; cursor: string }> {
  const url = new URL(`${mastodonApi(ctx)}/v1/notifications`);
  url.searchParams.append("types[]", "mention");
  url.searchParams.set("limit", "40");
  if (/^\d{1,30}$/.test(cursor)) url.searchParams.set("since_id", cursor);
  const res = await call(url.href, { token: ctx.token, signal: ctx.signal });
  ok(res);
  let list: Record<string, unknown>[] = [];
  try {
    const parsed: unknown = JSON.parse(res.raw.body);
    if (Array.isArray(parsed)) list = parsed.slice(0, 40) as Record<string, unknown>[];
  } catch {
    // Not a list: nothing new.
  }
  let newest = cursor;
  const items = list.flatMap((n) => {
    const id = idOf(n.id);
    if (/^\d{1,30}$/.test(id) && (!/^\d{1,30}$/.test(newest) || BigInt(id) > BigInt(newest))) newest = id;
    const status = (n.status ?? {}) as Record<string, unknown>;
    const statusId = idOf(status.id);
    if (n.type !== "mention" || !statusId) return [];
    const acct = oneLine((n.account as Record<string, unknown> | undefined)?.acct, 200);
    const link = String(status.url ?? "");
    return [{ remoteId: statusId, kind: "mention" as const, author: acct ? `@${acct}` : "", text: textOf(stripHtml(String(status.content ?? ""))), url: /^https:\/\/[^\s"]{1,500}$/.test(link) ? link : "", stars: 0, at: timeOf(status.created_at), ref: { id: statusId, acct } }];
  });
  return { items, cursor: newest };
}

// -------------------------------------------------------------------------------------- Telegram

export const BOT_TOKEN = /^\d{5,15}:[\w-]{30,60}$/;
const TG = (token: string, method: string) => `${socialHost("telegram", "https://api.telegram.org")}/bot${token}/${method}`;

async function tg(token: string, method: string, c: Call = {}) {
  const res = await call(TG(token, method), c);
  // Telegram says a bad token with 401 or 404, and a request it won't do with 400 or 403.
  if (res.status === 404) throw new SocialError("auth", PROBLEMS.auth);
  ok(res, c.write);
  if (res.body.ok !== true) throw new SocialError("refused", PROBLEMS.refused);
  return res.body.result;
}

/** Checks the bot and the chat it posts to: the bot must be an administrator there to post in a channel. */
async function telegramMe(token: string, chat: string): Promise<Found> {
  const me = (await tg(token, "getMe")) as Record<string, unknown>;
  const botId = idOf(me.id);
  const chatId = /^-?\d{1,20}$/.test(chat) ? chat : /^@[A-Za-z]\w{3,31}$/.test(chat) ? chat : "";
  if (!botId || !chatId) throw new SocialError("bad_input", PROBLEMS.bad_input);
  const info = (await tg(token, "getChat", { form: { chat_id: chatId } }).catch(() => {
    throw new SocialError("refused", msg("Telegram can't find that channel or group for this bot. Add the bot to it as an administrator first."));
  })) as Record<string, unknown>;
  const id = String(info.id ?? "");
  if (!/^-?\d{1,20}$/.test(id)) throw new SocialError("refused", PROBLEMS.refused);
  const member = (await tg(token, "getChatMember", { form: { chat_id: id, user_id: botId } }).catch(() => null)) as Record<string, unknown> | null;
  if (info.type === "channel" && member?.status !== "administrator" && member?.status !== "creator") {
    throw new SocialError("refused", msg("Make the bot an administrator of the channel, with the right to post, then connect again."));
  }
  const username = /^[A-Za-z]\w{3,31}$/.test(String(info.username ?? "")) ? String(info.username) : "";
  return {
    accountId: `${botId}:${id}`,
    name: oneLine(info.title, 100) || (username ? `@${username}` : `@${oneLine(me.username, 60)}`),
    targets: [],
    server: username ? `https://t.me/${username}` : "",
  };
}

const chatOf = (ctx: Ctx) => ctx.accountId.split(":")[1] ?? "";

async function telegramPost(ctx: Ctx, out: Outgoing, replyTo = ""): Promise<Posted> {
  const chat = chatOf(ctx);
  const reply: Record<string, string> = replyTo ? { reply_parameters: JSON.stringify({ message_id: Number(replyTo.split(":")[1] ?? replyTo) }) } : {};
  const target = replyTo ? replyTo.split(":")[0] : chat;
  let result: Record<string, unknown>;
  if (out.media) {
    const video = VIDEO_TYPES.test(out.media.mime);
    const form = formData([
      { name: "chat_id", value: target },
      ...(out.text ? [{ name: "caption", value: out.text }] : []),
      { name: video ? "video" : "photo", value: out.media.data, filename: out.media.name, type: out.media.mime },
    ]);
    result = (await tg(ctx.token, video ? "sendVideo" : "sendPhoto", { body: form.body, type: form.type, timeoutMs: 120_000, write: true, signal: ctx.signal })) as Record<string, unknown>;
  } else {
    result = (await tg(ctx.token, "sendMessage", { form: { chat_id: target, text: out.text, ...reply }, write: true, signal: ctx.signal })) as Record<string, unknown>;
  }
  const id = idOf(result?.message_id);
  return { remoteId: id, url: id && ctx.server.startsWith("https://t.me/") && !replyTo ? `${ctx.server}/${id}` : "" };
}

/** New messages to the bot, in its chat or sent to it directly. The update offset is the cursor. */
async function telegramInbox(ctx: Ctx, cursor: string): Promise<{ items: InboxIn[]; cursor: string }> {
  const offset = /^\d{1,20}$/.test(cursor) ? cursor : "";
  const updates = (await tg(ctx.token, "getUpdates", { form: { timeout: "0", limit: "100", allowed_updates: JSON.stringify(["message"]), ...(offset && { offset }) }, signal: ctx.signal })) as Record<string, unknown>[];
  let next = offset;
  const chat = chatOf(ctx);
  const items = (Array.isArray(updates) ? updates : []).flatMap((u) => {
    const updateId = Number(u.update_id);
    if (Number.isSafeInteger(updateId) && updateId + 1 > Number(next || 0)) next = String(updateId + 1);
    const m = (u.message ?? {}) as Record<string, unknown>;
    const from = (m.from ?? {}) as Record<string, unknown>;
    const c = (m.chat ?? {}) as Record<string, unknown>;
    const chatId = String(c.id ?? "");
    const messageId = idOf(m.message_id);
    if (!messageId || !/^-?\d{1,20}$/.test(chatId) || typeof m.text !== "string" || from.is_bot === true) return [];
    if (chatId !== chat && c.type !== "private") return [];
    const name = oneLine([from.first_name, from.last_name].filter(Boolean).join(" "), 100);
    const handle = /^[A-Za-z]\w{3,31}$/.test(String(from.username ?? "")) ? `@${from.username}` : "";
    return [{ remoteId: `${chatId}:${messageId}`, kind: c.type === "private" ? ("message" as const) : ("comment" as const), author: name || handle, text: textOf(m.text), url: "", stars: 0, at: timeOf(m.date), ref: { to: `${chatId}:${messageId}` } }];
  });
  return { items, cursor: next };
}

// ------------------------------------------------------------------------------------------ Meta

/*
 * Facebook Pages (Graph API, with each Page's own token), Instagram (Instagram Login, graph.instagram.com)
 * and Threads (graph.threads.net). Meta takes its token in the address (access_token), as its own
 * examples do. Instagram and Threads fetch a post's picture or video themselves, from a public
 * address Flash makes for that one post (Outgoing.mediaUrl), then publish it in a second step: only
 * that second step is the post, so only it is "unknown" when it gets no answer.
 */

const FB = () => `${socialHost("facebook", "https://graph.facebook.com")}/${GRAPH_VERSION}`;
const FB_VIDEO = () => `${socialHost("facebook", "https://graph-video.facebook.com")}/${GRAPH_VERSION}`;
const IG = () => `${socialHost("instagram", "https://graph.instagram.com")}/${GRAPH_VERSION}`;
const TH = () => `${socialHost("threads", "https://graph.threads.net")}/v1.0`;
const META_ID = /^\d{1,30}$/;
const FB_POST = /^\d{1,30}_\d{1,30}$/;

/** A Meta address with the token and fields in it. */
function metaUrl(base: string, token: string, params: Record<string, string> = {}): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  return url.href;
}

/** Meta's answer: its error 190 (a token taken back or run out) needs Reconnect, 4/17/32/613 are its limits. */
function metaOk(res: { status: number; body: Record<string, unknown> }, write = false, step = "") {
  const error = (res.body.error ?? null) as Record<string, unknown> | null;
  const code = Number(error?.code);
  const sub = Number(error?.error_subcode);
  const detail = error ? `${step || "meta"}:${Number.isFinite(code) ? code : "?"}${Number.isFinite(sub) ? `.${sub}` : ""}` : "";
  try {
    if (code === 190 || code === 102) throw new SocialError("auth", PROBLEMS.auth);
    if ([4, 17, 32, 613].includes(code)) throw new SocialError("limit", PROBLEMS.limit);
    if (error && res.status >= 200 && res.status < 300) throw new SocialError(write ? "unknown" : "refused", write ? PROBLEMS.unknown : PROBLEMS.refused);
    ok(res, write);
  } catch (err) {
    if (err instanceof SocialError && !err.detail) err.detail = detail || `${step || "meta"}:http${res.status}`;
    throw err;
  }
}

/** The Pages picked at sign-in, each with its own token, when /me/accounts lists none. */
async function facebookPickedPages(token: string): Promise<Record<string, unknown>[]> {
  const appId = process.env.SOCIAL_META_APP_ID?.trim() ?? "";
  const secret = process.env.SOCIAL_META_APP_SECRET?.trim() ?? "";
  if (!META_ID.test(appId) || !secret) return [];
  const debug = await call(metaUrl(`${FB()}/debug_token`, `${appId}|${secret}`, { input_token: token }));
  if (debug.status !== 200) return [];
  const data = (debug.body.data ?? {}) as Record<string, unknown>;
  const ids = new Set<string>();
  for (const g of Array.isArray(data.granular_scopes) ? (data.granular_scopes as Record<string, unknown>[]) : []) {
    if (!String(g.scope ?? "").startsWith("pages_") || !Array.isArray(g.target_ids)) continue;
    for (const id of g.target_ids) if (META_ID.test(String(id))) ids.add(String(id));
  }
  const pages: Record<string, unknown>[] = [];
  for (const id of [...ids].slice(0, 25)) {
    const page = await call(metaUrl(`${FB()}/${id}`, token, { fields: "id,name,access_token" }));
    if (page.status === 200 && !page.body.error) pages.push(page.body);
  }
  return pages;
}

/** Facebook: the person, and the Pages they let Flash use, each with its own token (kept sealed, never shown). */
async function facebookMe(token: string): Promise<Found> {
  const me = await call(metaUrl(`${FB()}/me`, token, { fields: "id,name" }));
  metaOk(me, false, "me");
  const id = META_ID.test(String(me.body.id ?? "")) ? String(me.body.id) : "";
  if (!id) throw new SocialError("refused", PROBLEMS.refused, "me:no_id");
  const pages = await call(metaUrl(`${FB()}/me/accounts`, token, { fields: "id,name,access_token", limit: "100" }));
  metaOk(pages, false, "pages");
  const tokens: Record<string, string> = {};
  const targets: { id: string; name: string }[] = [];
  let listed = ((pages.body.data ?? []) as Record<string, unknown>[]).slice(0, 100);
  // A Page a business portfolio owns isn't in /me/accounts without business_management: it's
  // asked for by the Pages the person picked at sign-in (the token's granular scopes) instead.
  if (!listed.length) listed = await facebookPickedPages(token);
  for (const p of listed) {
    const pageId = String(p.id ?? "");
    const pageToken = String(p.access_token ?? "");
    if (!META_ID.test(pageId) || !/^[\w-]{20,1024}$/.test(pageToken)) continue;
    tokens[pageId] = pageToken;
    targets.push({ id: pageId, name: oneLine(p.name, 100) || pageId });
  }
  if (!targets.length) {
    throw new SocialError("refused", msg("This Facebook account manages no Page yet. Make one, then connect again."), listed.length ? `pages:${listed.length}_without_token` : "pages:none");
  }
  return { accountId: id, name: oneLine(me.body.name, 100), targets, secret: JSON.stringify(tokens) };
}

async function facebookPost(ctx: Ctx, out: Outgoing): Promise<Posted> {
  const page = ctx.target;
  if (!META_ID.test(page)) throw new SocialError("bad_input", PROBLEMS.bad_input);
  let res;
  if (out.media) {
    const video = VIDEO_TYPES.test(out.media.mime);
    const form = formData([
      { name: video ? "description" : "message", value: out.text },
      { name: "source", value: out.media.data, filename: out.media.name, type: out.media.mime },
    ]);
    res = await call(metaUrl(`${video ? FB_VIDEO() : FB()}/${page}/${video ? "videos" : "photos"}`, ctx.token), { body: form.body, type: form.type, timeoutMs: UPLOAD_MS, write: true, signal: ctx.signal });
  } else {
    const link = /^https:\/\/\S{1,2000}$/.test(out.link) ? out.link : "";
    res = await call(metaUrl(`${FB()}/${page}/feed`, ctx.token), { form: { message: out.text, ...(link && { link }) }, write: true, signal: ctx.signal });
  }
  metaOk(res, true);
  const postId = String(res.body.post_id ?? res.body.id ?? "");
  if (!/^[\d_]{1,62}$/.test(postId)) throw new SocialError("unknown", PROBLEMS.unknown);
  const [owner, item] = FB_POST.test(postId) ? postId.split("_") : [page, postId];
  return { remoteId: postId, url: `https://www.facebook.com/${owner}/posts/${item}` };
}

async function facebookInbox(ctx: Ctx): Promise<{ items: InboxIn[]; cursor: string }> {
  const page = ctx.target;
  if (!META_ID.test(page)) return { items: [], cursor: "" };
  const items: InboxIn[] = [];
  const feed = await call(metaUrl(`${FB()}/${page}/feed`, ctx.token, { fields: "id,comments.limit(20).order(reverse_chronological){id,from,message,created_time,permalink_url}", limit: "10" }), { signal: ctx.signal });
  metaOk(feed);
  for (const post of ((feed.body.data ?? []) as Record<string, unknown>[]).slice(0, 10)) {
    for (const c of (((post.comments as Record<string, unknown> | undefined)?.data ?? []) as Record<string, unknown>[]).slice(0, 20)) {
      const id = String(c.id ?? "");
      const from = (c.from ?? {}) as Record<string, unknown>;
      if (!/^[\d_]{1,62}$/.test(id) || String(from.id ?? "") === page) continue;
      const link = String(c.permalink_url ?? "");
      items.push({ remoteId: id, kind: "comment", author: oneLine(from.name, 100), text: textOf(c.message), url: /^https:\/\/www\.facebook\.com\/[^\s"]{1,500}$/.test(link) ? link : "", stars: 0, at: timeOf(c.created_time), ref: { comment: id } });
    }
  }
  const chats = await call(metaUrl(`${FB()}/${page}/conversations`, ctx.token, { platform: "messenger", fields: "messages.limit(5){id,from,message,created_time}", limit: "10" }), { signal: ctx.signal });
  // Messages need their own permission: a Page without it still shows its comments.
  if (chats.status === 200) {
    for (const chat of ((chats.body.data ?? []) as Record<string, unknown>[]).slice(0, 10)) {
      for (const m of (((chat.messages as Record<string, unknown> | undefined)?.data ?? []) as Record<string, unknown>[]).slice(0, 5)) {
        const id = String(m.id ?? "");
        const from = (m.from ?? {}) as Record<string, unknown>;
        const who = String(from.id ?? "");
        if (!/^[\w.:-]{1,200}$/.test(id) || !META_ID.test(who) || who === page || typeof m.message !== "string" || !m.message) continue;
        items.push({ remoteId: id, kind: "message", author: oneLine(from.name, 100), text: textOf(m.message), url: "", stars: 0, at: timeOf(m.created_time), ref: { to: who } });
      }
    }
  }
  return { items, cursor: "" };
}

async function facebookReply(ctx: Ctx, ref: Record<string, string>, text: string): Promise<Posted> {
  const page = ctx.target;
  if (!META_ID.test(page)) throw new SocialError("bad_input", PROBLEMS.bad_input);
  let res;
  if (/^[\d_]{1,62}$/.test(ref.comment ?? "")) {
    res = await call(metaUrl(`${FB()}/${ref.comment}/comments`, ctx.token), { form: { message: text }, write: true, signal: ctx.signal });
  } else if (META_ID.test(ref.to ?? "")) {
    // Messenger allows an answer within 24 hours of the person's last message.
    res = await call(metaUrl(`${FB()}/${page}/messages`, ctx.token), { json: { recipient: { id: ref.to }, messaging_type: "RESPONSE", message: { text } }, write: true, signal: ctx.signal });
  } else {
    throw new SocialError("bad_input", PROBLEMS.bad_input);
  }
  metaOk(res, true);
  return { remoteId: oneLine(res.body.id ?? res.body.message_id, 200), url: "" };
}

/** Instagram (a professional account, signed in with Instagram): its own id for posting and messages, and its handle. */
async function instagramMe(token: string): Promise<Found> {
  const me = await call(metaUrl(`${IG()}/me`, token, { fields: "id,user_id,username" }));
  metaOk(me);
  const id = META_ID.test(String(me.body.user_id ?? "")) ? String(me.body.user_id) : META_ID.test(String(me.body.id ?? "")) ? String(me.body.id) : "";
  if (!id) throw new SocialError("refused", PROBLEMS.refused);
  // server keeps the id Meta names the person by in its deletion requests (their id for this app).
  return { accountId: id, name: `@${oneLine(me.body.username, 60)}`, targets: [], server: META_ID.test(String(me.body.id ?? "")) ? String(me.body.id) : "" };
}

/** Waits for Meta to fetch and process a picture or video (a video can take a minute or more). */
async function metaReady(statusUrl: () => string, field: string, signal: AbortSignal | undefined, maxMs: number) {
  const until = Date.now() + maxMs;
  for (;;) {
    const res = await call(statusUrl(), { signal });
    metaOk(res);
    const status = String(res.body[field] ?? "");
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") throw new SocialError("refused", PROBLEMS.refused);
    if (Date.now() > until) throw new SocialError("unreachable", PROBLEMS.unreachable);
    await new Promise((r) => setTimeout(r, mockDelay(3000)));
  }
}
// Tests don't wait.
const mockDelay = (ms: number) => (process.env.FLASH_CONNECT_MOCK ? 10 : ms);

async function instagramPost(ctx: Ctx, out: Outgoing): Promise<Posted> {
  if (!out.media || !out.mediaUrl) throw new SocialError("bad_input", PROBLEMS.bad_input);
  const video = VIDEO_TYPES.test(out.media.mime);
  const made = await call(metaUrl(`${IG()}/${ctx.accountId}/media`, ctx.token), {
    form: { caption: out.text, ...(video ? { media_type: "REELS", video_url: out.mediaUrl } : { image_url: out.mediaUrl }) },
    timeoutMs: 60_000,
    signal: ctx.signal,
  });
  metaOk(made);
  const container = String(made.body.id ?? "");
  if (!META_ID.test(container)) throw new SocialError("refused", PROBLEMS.refused);
  await metaReady(() => metaUrl(`${IG()}/${container}`, ctx.token, { fields: "status_code" }), "status_code", ctx.signal, video ? 240_000 : 60_000);
  const res = await call(metaUrl(`${IG()}/${ctx.accountId}/media_publish`, ctx.token), { form: { creation_id: container }, write: true, signal: ctx.signal });
  metaOk(res, true);
  const id = String(res.body.id ?? "");
  if (!META_ID.test(id)) throw new SocialError("unknown", PROBLEMS.unknown);
  const got = await call(metaUrl(`${IG()}/${id}`, ctx.token, { fields: "permalink" }), { signal: ctx.signal }).catch(() => null);
  const link = String(got?.body.permalink ?? "");
  return { remoteId: id, url: /^https:\/\/www\.instagram\.com\/[^\s"]{1,300}$/.test(link) ? link : "" };
}

async function instagramInbox(ctx: Ctx): Promise<{ items: InboxIn[]; cursor: string }> {
  const items: InboxIn[] = [];
  const media = await call(metaUrl(`${IG()}/me/media`, ctx.token, { fields: "id,permalink,comments.limit(20){id,text,username,timestamp}", limit: "10" }), { signal: ctx.signal });
  metaOk(media);
  for (const m of ((media.body.data ?? []) as Record<string, unknown>[]).slice(0, 10)) {
    const link = String(m.permalink ?? "");
    for (const c of (((m.comments as Record<string, unknown> | undefined)?.data ?? []) as Record<string, unknown>[]).slice(0, 20)) {
      const id = String(c.id ?? "");
      if (!META_ID.test(id)) continue;
      const user = oneLine(c.username, 60);
      items.push({ remoteId: id, kind: "comment", author: user ? `@${user}` : "", text: textOf(c.text), url: /^https:\/\/www\.instagram\.com\/[^\s"]{1,300}$/.test(link) ? link : "", stars: 0, at: timeOf(c.timestamp), ref: { comment: id } });
    }
  }
  const chats = await call(metaUrl(`${IG()}/me/conversations`, ctx.token, { platform: "instagram", fields: "messages.limit(5){id,from,message,created_time}", limit: "10" }), { signal: ctx.signal });
  if (chats.status === 200) {
    for (const chat of ((chats.body.data ?? []) as Record<string, unknown>[]).slice(0, 10)) {
      for (const m of (((chat.messages as Record<string, unknown> | undefined)?.data ?? []) as Record<string, unknown>[]).slice(0, 5)) {
        const id = String(m.id ?? "");
        const from = (m.from ?? {}) as Record<string, unknown>;
        const who = String(from.id ?? "");
        if (!/^[\w.:-]{1,300}$/.test(id) || !META_ID.test(who) || who === ctx.accountId || typeof m.message !== "string" || !m.message) continue;
        const user = oneLine(from.username, 60);
        items.push({ remoteId: id, kind: "message", author: user ? `@${user}` : "", text: textOf(m.message), url: "", stars: 0, at: timeOf(m.created_time), ref: { to: who } });
      }
    }
  }
  return { items, cursor: "" };
}

async function instagramReply(ctx: Ctx, ref: Record<string, string>, text: string): Promise<Posted> {
  let res;
  if (META_ID.test(ref.comment ?? "")) {
    res = await call(metaUrl(`${IG()}/${ref.comment}/replies`, ctx.token), { form: { message: text }, write: true, signal: ctx.signal });
  } else if (META_ID.test(ref.to ?? "")) {
    res = await call(metaUrl(`${IG()}/me/messages`, ctx.token), { json: { recipient: { id: ref.to }, message: { text } }, write: true, signal: ctx.signal });
  } else {
    throw new SocialError("bad_input", PROBLEMS.bad_input);
  }
  metaOk(res, true);
  return { remoteId: oneLine(res.body.id ?? res.body.message_id, 200), url: "" };
}

async function threadsMe(token: string): Promise<Found> {
  const me = await call(metaUrl(`${TH()}/me`, token, { fields: "id,username" }));
  metaOk(me);
  const id = META_ID.test(String(me.body.id ?? "")) ? String(me.body.id) : "";
  if (!id) throw new SocialError("refused", PROBLEMS.refused);
  const name = `@${oneLine(me.body.username, 60)}`;
  // server keeps the handle, so the account's own replies aren't shown in its inbox.
  return { accountId: id, name, targets: [], server: name };
}

async function threadsPost(ctx: Ctx, out: Outgoing, replyTo = ""): Promise<Posted> {
  const video = out.media ? VIDEO_TYPES.test(out.media.mime) : false;
  if (out.media && !out.mediaUrl) throw new SocialError("bad_input", PROBLEMS.bad_input);
  const link = !out.media && /^https:\/\/\S{1,2000}$/.test(out.link) ? out.link : "";
  const made = await call(metaUrl(`${TH()}/${ctx.accountId}/threads`, ctx.token), {
    form: {
      text: out.text,
      media_type: out.media ? (video ? "VIDEO" : "IMAGE") : "TEXT",
      ...(out.media && (video ? { video_url: out.mediaUrl! } : { image_url: out.mediaUrl! })),
      ...(link && { link_attachment: link }),
      ...(replyTo && { reply_to_id: replyTo }),
    },
    timeoutMs: 60_000,
    signal: ctx.signal,
  });
  metaOk(made);
  const container = String(made.body.id ?? "");
  if (!META_ID.test(container)) throw new SocialError("refused", PROBLEMS.refused);
  if (out.media) await metaReady(() => metaUrl(`${TH()}/${container}`, ctx.token, { fields: "status" }), "status", ctx.signal, video ? 240_000 : 60_000);
  const res = await call(metaUrl(`${TH()}/${ctx.accountId}/threads_publish`, ctx.token), { form: { creation_id: container }, write: true, signal: ctx.signal });
  metaOk(res, true);
  const id = String(res.body.id ?? "");
  if (!META_ID.test(id)) throw new SocialError("unknown", PROBLEMS.unknown);
  const got = await call(metaUrl(`${TH()}/${id}`, ctx.token, { fields: "permalink" }), { signal: ctx.signal }).catch(() => null);
  const permalink = String(got?.body.permalink ?? "");
  return { remoteId: id, url: /^https:\/\/www\.threads\.(net|com)\/[^\s"]{1,300}$/.test(permalink) ? permalink : "" };
}

async function threadsInbox(ctx: Ctx): Promise<{ items: InboxIn[]; cursor: string }> {
  const posts = await call(metaUrl(`${TH()}/me/threads`, ctx.token, { fields: "id", limit: "5" }), { signal: ctx.signal });
  metaOk(posts);
  const items: InboxIn[] = [];
  for (const p of ((posts.body.data ?? []) as Record<string, unknown>[]).slice(0, 5)) {
    const postId = String(p.id ?? "");
    if (!META_ID.test(postId)) continue;
    const replies = await call(metaUrl(`${TH()}/${postId}/replies`, ctx.token, { fields: "id,text,username,timestamp,permalink" }), { signal: ctx.signal });
    if (replies.status !== 200) continue;
    for (const r of ((replies.body.data ?? []) as Record<string, unknown>[]).slice(0, 25)) {
      const id = String(r.id ?? "");
      const user = oneLine(r.username, 60);
      if (!META_ID.test(id) || !user || `@${user}` === ctx.server) continue;
      const link = String(r.permalink ?? "");
      items.push({ remoteId: id, kind: "reply", author: `@${user}`, text: textOf(r.text), url: /^https:\/\/www\.threads\.(net|com)\/[^\s"]{1,300}$/.test(link) ? link : "", stars: 0, at: timeOf(r.timestamp), ref: { id } });
    }
  }
  return { items, cursor: "" };
}

// ----------------------------------------------------------------------------------- One surface

/** Who an account signed in as, with the places it can post to (Google: sub is the account's Google id). */
export async function lookupAccount(network: NetworkId, token: string, extra: { sub?: string; server?: string; chat?: string } = {}): Promise<Found> {
  switch (network) {
    case "x":
      return xMe(token);
    case "youtube":
      return youtubeMe(token);
    case "google-business":
      return businessMe(token, extra.sub ?? "");
    case "pinterest":
      return pinterestMe(token);
    case "facebook":
      return facebookMe(token);
    case "instagram":
      return instagramMe(token);
    case "threads":
      return threadsMe(token);
    case "mastodon":
      return mastodonMe(extra.server ?? "", token);
    case "telegram":
      return telegramMe(token, extra.chat ?? "");
    default:
      throw new SocialError("bad_input", PROBLEMS.bad_input);
  }
}

/** Posts on the account's network. */
export async function publish(ctx: Ctx, out: Outgoing): Promise<Posted> {
  switch (ctx.network) {
    case "x":
      return xPost(ctx, out);
    case "youtube":
      return youtubeUpload(ctx, out);
    case "google-business":
      return businessPost(ctx, out);
    case "pinterest":
      return pinterestPin(ctx, out);
    case "facebook":
      return facebookPost(ctx, out);
    case "instagram":
      return instagramPost(ctx, out);
    case "threads":
      return threadsPost(ctx, out);
    case "bluesky":
      return blueskyPost(ctx, out);
    case "mastodon":
      return mastodonPost(ctx, out);
    case "telegram":
      return telegramPost(ctx, out);
  }
}

/** What's new for the account since the cursor: comments, replies, mentions, messages or reviews. Pinterest has none. */
export async function readInbox(ctx: Ctx, cursor: string): Promise<{ items: InboxIn[]; cursor: string }> {
  switch (ctx.network) {
    case "x":
      return xMentions(ctx, cursor);
    case "youtube":
      return youtubeComments(ctx);
    case "google-business":
      return businessReviews(ctx);
    case "facebook":
      return facebookInbox(ctx);
    case "instagram":
      return instagramInbox(ctx);
    case "threads":
      return threadsInbox(ctx);
    case "bluesky":
      return blueskyInbox(ctx);
    case "mastodon":
      return mastodonInbox(ctx, cursor);
    case "telegram":
      return telegramInbox(ctx, cursor);
    default:
      return { items: [], cursor };
  }
}

/** Answers one inbox item, on its own network, with what reply needs from when it was read (ref). */
export async function reply(ctx: Ctx, ref: Record<string, string>, text: string, idempotencyKey: string): Promise<Posted> {
  const out = { text, title: "", link: "", media: null, idempotencyKey };
  switch (ctx.network) {
    case "x":
      if (!/^\d{1,30}$/.test(ref.id ?? "")) break;
      return xPost(ctx, out, ref.id);
    case "youtube":
      if (!ref.parent) break;
      return youtubeReply(ctx, ref, text);
    case "google-business":
      return businessReply(ctx, ref, text);
    case "facebook":
      return facebookReply(ctx, ref, text);
    case "instagram":
      return instagramReply(ctx, ref, text);
    case "threads":
      if (!META_ID.test(ref.id ?? "")) break;
      return threadsPost(ctx, out, ref.id);
    case "bluesky":
      if (!rkeyOf(ref.uri ?? "") || !rkeyOf(ref.rootUri ?? "")) break;
      return blueskyPost(ctx, out, { root: { uri: ref.rootUri, cid: ref.rootCid }, parent: { uri: ref.uri, cid: ref.cid } });
    case "mastodon": {
      if (!/^\d{1,30}$/.test(ref.id ?? "")) break;
      // Mastodon shows a reply to its author only when it names them.
      const named = ref.acct && !text.includes(`@${ref.acct}`) ? `@${ref.acct} ${text}` : text;
      return mastodonPost(ctx, { ...out, text: named }, ref.id);
    }
    case "telegram":
      if (!/^-?\d{1,20}:\d{1,20}$/.test(ref.to ?? "")) break;
      return telegramPost(ctx, out, ref.to);
  }
  throw new SocialError("bad_input", PROBLEMS.bad_input);
}
