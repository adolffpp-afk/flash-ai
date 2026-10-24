import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { register } from "node:module";
import type { AddressInfo } from "node:net";

/*
 * The Social hub (see social.ts, social-signin.ts and social-networks.ts), through Flash's own
 * routes: who sees it, connecting each network (sign-in with state and PKCE, or a key), posting now
 * and later (each delivery sent once, X charged in credits first), the inbox and replies, renewing
 * tokens and removing accounts, against stand-ins for X, Google, Pinterest, Facebook, Instagram,
 * Threads, Bluesky, Mastodon and Telegram made here. Nothing here reaches a real network.
 */
register("./support/route-hooks.mjs", import.meta.url);

const ORIGIN = "http://flash.test";
const b64url = (b: Buffer) => b.toString("base64url");
const challengeOf = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());
const jwt = (claims: object) => `${b64url(Buffer.from('{"alg":"none"}'))}.${b64url(Buffer.from(JSON.stringify(claims)))}.sig`;

const X = { id: "x-client", secret: "x-secret" };
const GOOGLE = { id: "google-client", secret: "google-secret" };
const PINTEREST = { id: "pin-client", secret: "pin-secret" };
const META = { id: "1483709763633789", secret: "meta-secret" };
const INSTAGRAM = { id: "ig-client", secret: "ig-secret" };
const THREADS = { id: "th-client", secret: "th-secret" };
const PAGE_TOKENS = { "601": "fbpagetoken601aaaaaaaaaaaaaaaa", "602": "fbpagetoken602bbbbbbbbbbbbbbbb" };
const BOT = "123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra";

const state = { xRefuseRefresh: false, xDown: false, gbpOpen: true, tgWebhook: false, fbBusinessPages: false };
const log = {
  tokens: [] as { network: string; form: Record<string, string>; basic: string }[],
  revoked: [] as string[],
  tweets: [] as Record<string, unknown>[],
  xMedia: 0,
  mentionReads: 0,
  uploads: [] as { meta: Record<string, unknown>; bytes: number }[],
  ytReplies: [] as Record<string, unknown>[],
  localPosts: [] as Record<string, unknown>[],
  reviewReplies: [] as { path: string; body: Record<string, unknown> }[],
  pins: [] as Record<string, unknown>[],
  bskyRecords: [] as Record<string, unknown>[],
  bskyLogins: 0,
  bskyRefreshes: 0,
  toots: [] as { body: Record<string, unknown>; key: string }[],
  tgSent: [] as { method: string; fields: Record<string, string> }[],
  meta: [] as { path: string; token: string; fields: Record<string, string>; json: Record<string, unknown> }[],
  metaTokens: [] as { network: string; params: Record<string, string> }[],
  mediaUrls: [] as { url: string; shared: boolean }[],
};
const codes = new Map<string, { network: string; challenge: string; redirect: string }>();
const live = new Map<string, string>();
const refreshes = new Map<string, string>();
let issued = 0;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer /, "");
const basicOf = (req: IncomingMessage) => Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
const issue = (network: string, expiresIn = 7200) => {
  issued++;
  const token = `${network}-access-${issued}`;
  const refresh = `${network}-refresh-${issued}`;
  live.set(token, network);
  refreshes.set(refresh, network);
  return { access_token: token, refresh_token: refresh, expires_in: expiresIn, token_type: "bearer" };
};
/** The fields of a multipart/form-data body, files by their size. */
function fieldsOf(body: Buffer, type: string): Record<string, string> {
  const boundary = /boundary=(\S+)/.exec(type)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    if (!name) continue;
    const value = part.slice(part.indexOf("\r\n\r\n") + 4, -2);
    out[name] = /filename=/.test(part) ? `file:${value.length}` : value;
  }
  return out;
}

const mock = createServer(async (req, res) => {
  const url = new URL(req.url!, mockOrigin);
  const path = url.pathname;
  const body = await read(req);
  const form = Object.fromEntries(new URLSearchParams(body.toString()));
  const asked = () => (body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : {});

  // ---- the sign-in pages: they say yes at once.
  const authorize = (network: string, client: string) => {
    if (url.searchParams.get("client_id") !== client) return json(res, 400, { error: "bad client" });
    const code = `code-${network}-${randomBytes(4).toString("hex")}`;
    codes.set(code, { network, challenge: url.searchParams.get("code_challenge") ?? "", redirect: url.searchParams.get("redirect_uri") ?? "" });
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state")!);
    res.writeHead(302, { location: back.href });
    return res.end();
  };
  if (path === "/social/x/x.com/i/oauth2/authorize") return authorize("x", X.id);
  if (path.endsWith("/accounts.google.com/o/oauth2/v2/auth")) return authorize(path.split("/")[2], GOOGLE.id);
  if (path === "/social/pinterest/www.pinterest.com/oauth/") return authorize("pinterest", PINTEREST.id);
  if (path === "/social/facebook/www.facebook.com/v23.0/dialog/oauth") return authorize("facebook", META.id);
  if (path === "/social/instagram/www.instagram.com/oauth/authorize") return authorize("instagram", INSTAGRAM.id);
  if (path === "/social/threads/threads.net/oauth/authorize") return authorize("threads", THREADS.id);

  // ---- token endpoints.
  const tokenEndpoint = (network: string, ok: boolean, idToken = "") => {
    log.tokens.push({ network, form, basic: basicOf(req) });
    if (!ok) return json(res, 401, { error: "invalid_client" });
    if (form.grant_type === "authorization_code") {
      const c = codes.get(form.code);
      codes.delete(form.code);
      if (!c || c.redirect !== form.redirect_uri) return json(res, 400, { error: "invalid_grant" });
      if (c.challenge && challengeOf(form.code_verifier ?? "") !== c.challenge) return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { ...issue(network), ...(idToken && { id_token: idToken }) });
    }
    if (form.grant_type === "refresh_token") {
      if (state.xRefuseRefresh && network === "x") return json(res, 400, { error: "invalid_request", error_description: "Value passed for the token was invalid." });
      if (refreshes.get(form.refresh_token) !== network) return json(res, 400, { error: "invalid_grant" });
      // X's refresh tokens work once.
      if (network === "x") refreshes.delete(form.refresh_token);
      return json(res, 200, issue(network));
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  };
  if (path === "/social/x/api.x.com/2/oauth2/token") return tokenEndpoint("x", basicOf(req) === `${X.id}:${X.secret}`);
  if (path === "/social/x/api.x.com/2/oauth2/revoke") {
    log.revoked.push(form.token);
    return json(res, 200, { revoked: true });
  }
  if (/^\/social\/(youtube|google-business)\/oauth2\.googleapis\.com\/token$/.test(path)) {
    const network = path.split("/")[2];
    return tokenEndpoint(network, form.client_id === GOOGLE.id && form.client_secret === GOOGLE.secret, jwt({ sub: network === "youtube" ? "1111" : "2222", iss: "https://accounts.google.com" }));
  }
  if (/oauth2\.googleapis\.com\/revoke$/.test(path)) {
    log.revoked.push(form.token);
    return json(res, 200, {});
  }
  if (path === "/social/pinterest/api.pinterest.com/v5/oauth/token") return tokenEndpoint("pinterest", basicOf(req) === `${PINTEREST.id}:${PINTEREST.secret}`);

  // ---- Meta: the sign-in's code for an hour-long token, then that for a 60-day one.
  const metaCode = (network: string, params: Record<string, string>, client: { id: string; secret: string }) => {
    log.metaTokens.push({ network, params });
    const c = codes.get(params.code);
    codes.delete(params.code);
    if (params.client_id !== client.id || params.client_secret !== client.secret || !c || c.redirect !== params.redirect_uri) return json(res, 400, { error: { code: 100, message: "bad" } });
    const t = issue(`${network}short`, 3600);
    return json(res, 200, network === "instagram" ? { data: [{ access_token: t.access_token, user_id: "17841400000000001", permissions: "x" }] } : { access_token: t.access_token, token_type: "bearer", expires_in: 3600 });
  };
  const metaLong = (network: string, params: Record<string, string>, given: string, secret: string) => {
    log.metaTokens.push({ network, params });
    if (params.client_secret !== secret || live.get(given) !== `${network}short`) return json(res, 400, { error: { code: 190, message: "bad" } });
    const t = issue(network, 5184000);
    return json(res, 200, { access_token: t.access_token, token_type: "bearer", expires_in: 5184000 });
  };
  const metaRenew = (network: string, given: string) => {
    log.metaTokens.push({ network, params: Object.fromEntries(url.searchParams) });
    if (live.get(given) !== network) return json(res, 400, { error: { code: 190 } });
    const t = issue(network, 5184000);
    return json(res, 200, { access_token: t.access_token, token_type: "bearer", expires_in: 5184000 });
  };
  const q = Object.fromEntries(url.searchParams);
  if (path === "/social/facebook/graph.facebook.com/v23.0/oauth/access_token") {
    if (q.grant_type === "fb_exchange_token") return metaLong("facebook", q, q.fb_exchange_token, META.secret);
    return metaCode("facebook", q, META);
  }
  if (path === "/social/instagram/api.instagram.com/oauth/access_token") return metaCode("instagram", form, INSTAGRAM);
  if (path === "/social/instagram/graph.instagram.com/access_token") return metaLong("instagram", q, q.access_token, INSTAGRAM.secret);
  if (path === "/social/instagram/graph.instagram.com/refresh_access_token") return metaRenew("instagram", q.access_token);
  if (path === "/social/threads/graph.threads.net/oauth/access_token") return metaCode("threads", form, THREADS);
  if (path === "/social/threads/graph.threads.net/access_token") return metaLong("threads", q, q.access_token, THREADS.secret);
  if (path === "/social/threads/graph.threads.net/refresh_access_token") return metaRenew("threads", q.access_token);

  // ---- Meta's APIs: the token in the address.
  const metaApi = /^\/social\/(facebook|instagram|threads)\/(graph\.facebook\.com|graph-video\.facebook\.com|graph\.instagram\.com|graph\.threads\.net)\/(v23\.0|v1\.0)(\/.*)$/.exec(path);
  if (metaApi) {
    const [, network, , , api] = metaApi;
    const token = q.access_token ?? "";
    const type = String(req.headers["content-type"] ?? "");
    const fields = type.startsWith("multipart/") ? fieldsOf(body, type) : type.includes("json") ? {} : form;
    if (req.method === "POST") log.meta.push({ path: `${network}${api}`, token, fields, json: type.includes("json") ? asked() : {} });
    const pageOf = Object.entries(PAGE_TOKENS).find(([, t]) => t === token)?.[0];
    if (network === "facebook") {
      // A Page a business portfolio owns: not in /me/accounts, but in the token's granular scopes.
      if (api === "/debug_token") {
        if (token !== `${META.id}|${META.secret}` || live.get(q.input_token) !== "facebook") return json(res, 400, { error: { code: 190 } });
        return json(res, 200, { data: { granular_scopes: [{ scope: "pages_show_list", target_ids: ["602"] }, { scope: "pages_manage_posts", target_ids: ["602"] }] } });
      }
      if (api === "/602" && live.get(token) === "facebook") return json(res, 200, { id: "602", name: "Dana's Cafe", access_token: PAGE_TOKENS["602"] });
      if (api === "/me" || api === "/me/accounts") {
        if (live.get(token) !== "facebook") return json(res, 400, { error: { code: 190 } });
        if (api === "/me") return json(res, 200, { id: "10001", name: "Dana Baker" });
        if (state.fbBusinessPages) return json(res, 200, { data: [] });
        return json(res, 200, { data: [{ id: "601", name: "Dana's Bakery", access_token: PAGE_TOKENS["601"] }, { id: "602", name: "Dana's Cafe", access_token: PAGE_TOKENS["602"] }] });
      }
      if (!pageOf) return json(res, 400, { error: { code: 190 } });
      if (api === `/${pageOf}/feed` && req.method === "POST") return json(res, 200, { id: `${pageOf}_7001` });
      if (api === `/${pageOf}/photos`) return json(res, 200, { id: "8001", post_id: `${pageOf}_7002` });
      if (api === `/${pageOf}/videos`) return json(res, 200, { id: "8002" });
      if (api === `/${pageOf}/feed`) return json(res, 200, { data: [{ id: `${pageOf}_7001`, comments: { data: [{ id: "7001_91", from: { id: "333", name: "Ana" }, message: "Open today?", created_time: "2026-10-23T10:00:00+0000", permalink_url: "https://www.facebook.com/601/posts/7001?comment_id=91" }, { id: "7001_92", from: { id: pageOf, name: "Dana's Bakery" }, message: "our own", created_time: "2026-10-23T10:00:00+0000" }] } }] });
      if (api === `/${pageOf}/conversations`) return json(res, 200, { data: [{ messages: { data: [{ id: "m_1", from: { id: "444", name: "Lee" }, message: "Do you cater?", created_time: "2026-10-23T11:00:00+0000" }] } }] });
      if (api === "/7001_91/comments") return json(res, 200, { id: "7001_95" });
      if (api === `/${pageOf}/messages`) return json(res, 200, { recipient_id: "444", message_id: "m_2" });
      return json(res, 404, {});
    }
    if (live.get(token) !== network) return json(res, 400, { error: { code: 190, message: "expired" } });
    if (network === "instagram") {
      if (api === "/me") return json(res, 200, { id: "26000000000000001", user_id: "17841400000000001", username: "danabakes" });
      if (api === "/17841400000000001/media") {
        const at = fields.image_url ?? fields.video_url ?? "";
        const shared = await one("SELECT 1 AS ok FROM public_files WHERE id = ?", [at.split("/f/")[1] ?? ""]);
        log.mediaUrls.push({ url: at, shared: !!shared });
        return json(res, 200, { id: "1790001" });
      }
      if (api === "/1790001") return json(res, 200, { status_code: "FINISHED", id: "1790001" });
      if (api === "/17841400000000001/media_publish") return json(res, 200, { id: "1790002" });
      if (api === "/1790002") return json(res, 200, { permalink: "https://www.instagram.com/p/ABC123/" });
      if (api === "/me/media") return json(res, 200, { data: [{ id: "1790002", permalink: "https://www.instagram.com/p/ABC123/", comments: { data: [{ id: "1790100", text: "Yum!", username: "sam", timestamp: "2026-10-23T12:00:00+0000" }] } }] });
      if (api === "/me/conversations") return json(res, 200, { data: [{ messages: { data: [{ id: "aWdfZAG1", from: { id: "555", username: "ana_k" }, message: "Price?", created_time: "2026-10-23T12:30:00+0000" }, { id: "aWdfZAG2", from: { id: "17841400000000001", username: "danabakes" }, message: "mine", created_time: "2026-10-23T12:31:00+0000" }] } }] });
      if (api === "/1790100/replies") return json(res, 200, { id: "1790101" });
      if (api === "/me/messages") return json(res, 200, { recipient_id: "555", message_id: "aWdfZAG3" });
      return json(res, 404, {});
    }
    if (api === "/me") return json(res, 200, { id: "2600000000000009", username: "danabakes" });
    if (api === "/2600000000000009/threads") return json(res, 200, { id: "1800001" });
    if (api === "/1800001") return json(res, 200, { status: "FINISHED", id: "1800001" });
    if (api === "/2600000000000009/threads_publish") return json(res, 200, { id: "1800002" });
    if (api === "/1800002") return json(res, 200, { permalink: "https://www.threads.net/@danabakes/post/XYZ" });
    if (api === "/me/threads") return json(res, 200, { data: [{ id: "1800002" }] });
    if (api === "/1800002/replies") return json(res, 200, { data: [{ id: "1800050", text: "Gluten free?", username: "lee", timestamp: "2026-10-23T13:00:00+0000", permalink: "https://www.threads.net/@lee/post/R1" }, { id: "1800051", text: "self", username: "danabakes", timestamp: "2026-10-23T13:01:00+0000" }] });
    return json(res, 404, {});
  }

  // ---- X's API.
  if (path.startsWith("/social/x/api.x.com/2/")) {
    if (state.xDown) {
      req.socket.destroy();
      return;
    }
    if (live.get(bearer(req)) !== "x") return json(res, 401, { title: "Unauthorized" });
    const api = path.slice("/social/x/api.x.com/2".length);
    if (api === "/users/me") return json(res, 200, { data: { id: "4242", username: "flashshop" } });
    if (api === "/media/upload") {
      log.xMedia++;
      return json(res, 200, { data: { id: "777" } });
    }
    if (api === "/tweets") {
      log.tweets.push(asked());
      return json(res, 201, { data: { id: String(9000 + log.tweets.length), text: "x" } });
    }
    if (api === "/users/4242/mentions") {
      log.mentionReads++;
      return json(res, 200, {
        data: [
          { id: "501", text: "@flashshop how much is shipping?", author_id: "77", created_at: "2026-10-23T10:00:00Z" },
          { id: "502", text: "@flashshop love it", author_id: "78", created_at: "2026-10-23T11:00:00Z" },
        ],
        includes: { users: [{ id: "77", username: "dana" }, { id: "78", username: "sam" }] },
        meta: { newest_id: "502", result_count: 2 },
      });
    }
    return json(res, 404, {});
  }

  // ---- Google: YouTube and Business Profile.
  if (path.startsWith("/social/youtube/www.googleapis.com/")) {
    if (live.get(bearer(req)) !== "youtube") return json(res, 401, { error: { code: 401 } });
    const api = path.slice("/social/youtube/www.googleapis.com".length);
    if (api === "/youtube/v3/channels") return json(res, 200, { items: [{ id: "UCflash", snippet: { title: "Flash Shop TV" } }] });
    if (api === "/upload/youtube/v3/videos") {
      const type = String(req.headers["content-type"]);
      assert.match(type, /^multipart\/related; boundary=/);
      const meta = JSON.parse(/\r\n\r\n(\{.*\})\r\n/.exec(body.toString("latin1"))![1]) as Record<string, unknown>;
      log.uploads.push({ meta, bytes: body.length });
      return json(res, 200, { id: "vid123" });
    }
    if (api === "/youtube/v3/commentThreads") {
      return json(res, 200, { items: [{ id: "thread1", snippet: { videoId: "vid123", topLevelComment: { id: "c1", snippet: { authorDisplayName: "Ana", textOriginal: "Great video!", publishedAt: "2026-10-23T09:00:00Z" } } } }] });
    }
    if (api === "/youtube/v3/comments") {
      log.ytReplies.push(asked());
      return json(res, 200, { id: "reply1" });
    }
    return json(res, 404, {});
  }
  if (path.startsWith("/social/google-business/")) {
    if (live.get(bearer(req)) !== "google-business") return json(res, 401, {});
    if (!state.gbpOpen) return json(res, 403, { error: { status: "PERMISSION_DENIED" } });
    if (path.endsWith("/v1/accounts")) return json(res, 200, { accounts: [{ name: "accounts/100", accountName: "Dana's Bakery" }] });
    if (path.endsWith("/v1/accounts/100/locations")) return json(res, 200, { locations: [{ name: "locations/200", title: "Dana's Bakery Main St" }, { name: "locations/201", title: "Dana's Bakery Airport" }] });
    if (path.endsWith("/v4/accounts/100/locations/200/localPosts")) {
      log.localPosts.push(asked());
      return json(res, 200, { name: "accounts/100/locations/200/localPosts/55", searchUrl: "https://www.google.com/search?q=post" });
    }
    if (path.endsWith("/v4/accounts/100/locations/200/reviews")) {
      return json(res, 200, { reviews: [{ name: "accounts/100/locations/200/reviews/r1", reviewer: { displayName: "Lee" }, starRating: "FOUR", comment: "Nice bread", createTime: "2026-10-22T08:00:00Z" }] });
    }
    if (req.method === "PUT" && path.endsWith("/reviews/r1/reply")) {
      log.reviewReplies.push({ path, body: asked() });
      return json(res, 200, { comment: "ok" });
    }
    return json(res, 404, {});
  }

  // ---- Pinterest.
  if (path.startsWith("/social/pinterest/api.pinterest.com/v5/")) {
    if (live.get(bearer(req)) !== "pinterest") return json(res, 401, {});
    const api = path.slice("/social/pinterest/api.pinterest.com/v5".length);
    if (api === "/user_account") return json(res, 200, { username: "danabakes", id: "9988" });
    if (api === "/boards") return json(res, 200, { items: [{ id: "111", name: "Cakes" }, { id: "112", name: "Bread" }] });
    if (api === "/pins") {
      log.pins.push(asked());
      return json(res, 201, { id: "333" });
    }
    return json(res, 404, {});
  }

  // ---- Bluesky.
  if (path.startsWith("/social/bluesky/bsky.social/xrpc/")) {
    const method = path.slice("/social/bluesky/bsky.social/xrpc/".length);
    const session = () => {
      issued++;
      const access = jwt({ exp: Math.floor(Date.now() / 1000) + 7200, n: issued });
      const refresh = `bskyrefresh${issued}xxxxxxxxxxxxxxxxxxxxx`;
      live.set(access, "bluesky");
      refreshes.set(refresh, "bluesky");
      return { accessJwt: access, refreshJwt: refresh, did: "did:plc:abcdefghijklmnop", handle: "dana.bsky.social" };
    };
    if (method === "com.atproto.server.createSession") {
      log.bskyLogins++;
      const a = asked();
      if (a.identifier !== "dana.bsky.social" || a.password !== "abcd-efgh-ijkl-mnop") return json(res, 401, { error: "AuthenticationRequired" });
      return json(res, 200, session());
    }
    if (method === "com.atproto.server.refreshSession") {
      log.bskyRefreshes++;
      if (refreshes.get(bearer(req)) !== "bluesky") return json(res, 400, { error: "ExpiredToken" });
      refreshes.delete(bearer(req));
      return json(res, 200, session());
    }
    if (live.get(bearer(req)) !== "bluesky") return json(res, 400, { error: "ExpiredToken" });
    if (method === "com.atproto.repo.uploadBlob") return json(res, 200, { blob: { $type: "blob", ref: { $link: "bafyblob" }, mimeType: req.headers["content-type"], size: body.length } });
    if (method === "com.atproto.repo.createRecord") {
      log.bskyRecords.push(asked());
      return json(res, 200, { uri: `at://did:plc:abcdefghijklmnop/app.bsky.feed.post/3kpost${log.bskyRecords.length}`, cid: "bafyreicid000001" });
    }
    if (method.startsWith("app.bsky.notification.listNotifications")) {
      return json(res, 200, {
        notifications: [
          { uri: "at://did:plc:zzz/app.bsky.feed.post/3kreply1", cid: "bafyreireply01", reason: "reply", author: { handle: "sam.bsky.social" }, record: { text: "Is it vegan?", reply: { root: { uri: "at://did:plc:abcdefghijklmnop/app.bsky.feed.post/3kpost1", cid: "bafyreiroot0001" } } }, indexedAt: "2026-10-23T12:00:00Z" },
          { uri: "at://did:plc:zzz/app.bsky.feed.post/3klike", cid: "bafyreilike001", reason: "like", author: { handle: "x.bsky.social" }, record: {}, indexedAt: "2026-10-23T12:00:00Z" },
        ],
      });
    }
    return json(res, 404, {});
  }

  // ---- Mastodon (a server the user named: mastodon.example).
  if (path.startsWith("/social/mastodon/mastodon.example/api/")) {
    if (bearer(req) !== "mastodon-token-0123456789") return json(res, 401, { error: "The access token is invalid" });
    const api = path.slice("/social/mastodon/mastodon.example/api".length);
    if (api === "/v1/accounts/verify_credentials") return json(res, 200, { id: "10", acct: "dana" });
    if (api === "/v2/media") return json(res, 200, { id: "m1" });
    if (api === "/v1/statuses") {
      log.toots.push({ body: asked(), key: String(req.headers["idempotency-key"] ?? "") });
      return json(res, 200, { id: String(500 + log.toots.length), url: `https://mastodon.example/@dana/${500 + log.toots.length}` });
    }
    if (api === "/v1/notifications") {
      return json(res, 200, [{ id: "900", type: "mention", account: { acct: "lee@other.social" }, status: { id: "800", content: "<p>@dana open on Sunday?</p>", url: "https://other.social/@lee/800", created_at: "2026-10-23T08:00:00Z" } }]);
    }
    return json(res, 404, {});
  }

  // ---- Telegram.
  if (path.startsWith(`/social/telegram/api.telegram.org/bot`)) {
    const [, token, method] = /^\/social\/telegram\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(path) ?? [];
    if (token !== BOT) return json(res, 401, { ok: false, description: "Unauthorized" });
    const fields = String(req.headers["content-type"]).startsWith("multipart/") ? fieldsOf(body, String(req.headers["content-type"])) : form;
    if (method === "getMe") return json(res, 200, { ok: true, result: { id: 123456789, is_bot: true, username: "danabot" } });
    if (method === "getChat") {
      if (fields.chat_id !== "@danabakery") return json(res, 400, { ok: false, description: "Bad Request: chat not found" });
      return json(res, 200, { ok: true, result: { id: -1001234, type: "channel", title: "Dana's Bakery", username: "danabakery" } });
    }
    if (method === "getChatMember") return json(res, 200, { ok: true, result: { status: "administrator" } });
    if (method === "sendMessage" || method === "sendPhoto" || method === "sendVideo") {
      log.tgSent.push({ method, fields });
      return json(res, 200, { ok: true, result: { message_id: 40 + log.tgSent.length } });
    }
    if (method === "getUpdates") {
      if (state.tgWebhook) return json(res, 409, { ok: false, description: "Conflict" });
      const offset = Number(fields.offset ?? 0);
      const updates = [
        { update_id: 700, message: { message_id: 5, chat: { id: 555, type: "private" }, from: { id: 555, first_name: "Ana", username: "ana_k" }, text: "Do you deliver?", date: 1792000000 } },
        { update_id: 701, message: { message_id: 6, chat: { id: -100999, type: "group" }, from: { id: 9, first_name: "Spam" }, text: "other group", date: 1792000000 } },
      ].filter((u) => u.update_id >= offset);
      return json(res, 200, { ok: true, result: updates });
    }
    return json(res, 404, { ok: false });
  }
  json(res, 404, { error: "no such stand-in" });
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const mockOrigin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

process.env.DATABASE_URL = ":memory:";
process.env.CONNECTOR_KEYS = JSON.stringify({ v1: randomBytes(32).toString("base64") });
process.env.FLASH_APP_URL = ORIGIN;
process.env.FLASH_CONNECT_MOCK = mockOrigin;
process.env.FLASH_ADMIN_EMAILS = Array.from({ length: 24 }, (_, i) => `owner${i + 1}@example.com`).join(",");
process.env.SOCIAL_X_CLIENT_ID = X.id;
process.env.SOCIAL_X_CLIENT_SECRET = X.secret;
process.env.SOCIAL_GOOGLE_CLIENT_ID = GOOGLE.id;
process.env.SOCIAL_GOOGLE_CLIENT_SECRET = GOOGLE.secret;
process.env.SOCIAL_PINTEREST_CLIENT_ID = PINTEREST.id;
process.env.SOCIAL_PINTEREST_CLIENT_SECRET = PINTEREST.secret;
process.env.SOCIAL_META_APP_ID = META.id;
process.env.SOCIAL_META_APP_SECRET = META.secret;
process.env.SOCIAL_INSTAGRAM_APP_ID = INSTAGRAM.id;
process.env.SOCIAL_INSTAGRAM_APP_SECRET = INSTAGRAM.secret;
process.env.SOCIAL_THREADS_APP_ID = THREADS.id;
process.env.SOCIAL_THREADS_APP_SECRET = THREADS.secret;
delete process.env.SOCIAL_META_CONFIG_ID;
delete process.env.FLASH_SOCIAL_OPEN;
delete process.env.VERCEL_ENV;
delete process.env.RESEND_API_KEY;
after(async () => {
  mock.closeAllConnections();
  mock.close();
});

const { one, all, run: sql } = await import("../src/lib/server/db.ts");
const { balance, ensureMonthlyCredits } = await import("../src/lib/server/credits.ts");
const { socialTick, sendDue } = await import("../src/lib/server/social.ts");
const { blueskyFacets } = await import("../src/lib/server/social-networks.ts");
const { xPostCredits, xReadCredits, xMentionsCredits, textLength, hasLink } = await import("../src/lib/social.ts");
const { adminStats } = await import("../src/lib/server/admin-stats.ts");
const { afterwards } = (await import("./support/next-server.mjs")) as unknown as { afterwards: () => Promise<unknown> };
const routes = {
  hub: await import("../src/app/api/social/route.ts"),
  accounts: await import("../src/app/api/social/accounts/route.ts"),
  callback: await import("../src/app/api/social/callback/route.ts"),
  posts: await import("../src/app/api/social/posts/route.ts"),
  inbox: await import("../src/app/api/social/inbox/route.ts"),
  reply: await import("../src/app/api/social/inbox/reply/route.ts"),
  metaDelete: await import("../src/app/api/social/meta/delete/route.ts"),
  metaDeauthorize: await import("../src/app/api/social/meta/deauthorize/route.ts"),
};

beforeEach(() => {
  state.xRefuseRefresh = false;
  state.xDown = false;
  state.gbpOpen = true;
  state.tgWebhook = false;
});

async function account(id: string, { email = `${id}@example.com`, verified = true } = {}) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, ?)", [id, email, verified ? 1 : 0]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  return { id, cookie: `flash_session=${token}` };
}
type Account = Awaited<ReturnType<typeof account>>;
let owners = 0;
const owner = (id: string) => account(id, { email: `owner${++owners}@example.com` });

const request = (method: string, path: string, user: Account, body?: object, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: user.cookie, ...(origin !== null && { origin }) },
    ...(body && { body: JSON.stringify(body) }),
  });

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const keep = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, keep);
  }
};

async function call<T = Record<string, unknown>>(handler: (r: Request) => Promise<Response>, method: string, path: string, user: Account, body?: object, origin: string | null = ORIGIN) {
  const res = await quiet(() => handler(request(method, path, user, body, origin)));
  return { status: res.status, body: (await res.json()) as T & { error?: string } };
}

type Hub = { networks: string[]; accounts: { id: string; network: string; name: string; status: string; targets: { id: string }[]; target: string }[]; posts: { id: string; deliveries: { network: string; status: string; url: string; problem: string; credits: number }[] }[]; inbox: { id: string; network: string; kind: string; author: string; text: string; stars: number; repliedAt: number }[] };
const hub = async (user: Account) => (await call<Hub>(routes.hub.GET, "GET", "/api/social", user)).body;

/** Connect through a sign-in: start, the network's page (which says yes), and the callback. */
async function signIn(user: Account, network: string) {
  const started = await call<{ url: string }>(routes.accounts.POST, "POST", "/api/social/accounts", user, { network });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const page = await fetch(started.body.url, { redirect: "manual" });
  assert.equal(page.status, 302);
  const back = new URL(page.headers.get("location")!);
  assert.equal(back.origin + back.pathname, `${ORIGIN}/api/social/callback`);
  const res = await quiet(() => routes.callback.GET(new Request(back.href, { headers: { cookie: user.cookie } })));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const to = new URL(res.headers.get("location")!).searchParams;
  return { outcome: to.get("social"), why: to.get("why"), page: new URL(started.body.url) };
}

async function picture(userId: string, mime = "image/png", bytes = 2048) {
  const id = `file${randomBytes(8).toString("hex")}`;
  await sql("INSERT INTO files (id, user_id, mime, name, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, userId, mime, mime.startsWith("video") ? "ad.mp4" : "cake.png", Buffer.alloc(bytes, 7), Date.now()]);
  return id;
}

async function post(user: Account, body: object) {
  const made = await call<{ id: string }>(routes.posts.POST, "POST", "/api/social/posts", user, body);
  await quiet(afterwards);
  return made;
}

const accountOf = async (user: Account, network: string) => (await hub(user)).accounts.find((a) => a.network === network)!;

test("links and lengths: X counts a link as 23 and prices a post with one higher; Bluesky's links and tags are marked by byte", () => {
  assert.equal(textLength("x", "Hi https://flash-app.dev/a/very/long/path/that/goes/on"), 3 + 23);
  assert.ok(hasLink("see flash-app.dev"));
  assert.ok(!hasLink("no link here."));
  assert.ok(xPostCredits("see https://a.example.com") > xPostCredits("plain words"));
  assert.equal(xReadCredits(0), 0);
  assert.ok(xMentionsCredits() >= xReadCredits(2));
  const facets = blueskyFacets("Café ☕ https://flash-app.dev #bread!");
  const link = facets.find((f) => JSON.stringify(f).includes("#link")) as { index: { byteStart: number; byteEnd: number } };
  assert.deepEqual(link.index, { byteStart: Buffer.byteLength("Café ☕ "), byteEnd: Buffer.byteLength("Café ☕ https://flash-app.dev") });
  assert.ok(facets.some((f) => JSON.stringify(f).includes('"tag":"bread"')));
});

test("only Flash's owners see the Social hub until it's opened; changes only from Flash's own page", async () => {
  const user = await account("sh-user");
  const boss = await owner("sh-boss");
  assert.equal((await call(routes.hub.GET, "GET", "/api/social", user)).status, 404);
  assert.equal((await call(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "x" })).status, 404);
  const seen = await hub(boss);
  assert.deepEqual(seen.networks.sort(), ["bluesky", "facebook", "google-business", "instagram", "mastodon", "pinterest", "telegram", "threads", "x", "youtube"]);
  assert.equal((await call(routes.accounts.POST, "POST", "/api/social/accounts", boss, { network: "x" }, "https://evil.example")).status, 403);
  assert.equal((await call(routes.accounts.POST, "POST", "/api/social/accounts", boss, { network: "x" }, null)).status, 403);
  process.env.FLASH_SOCIAL_OPEN = "true";
  try {
    assert.equal((await call(routes.hub.GET, "GET", "/api/social", user)).status, 200);
  } finally {
    delete process.env.FLASH_SOCIAL_OPEN;
  }
  // A network whose app isn't set up isn't offered.
  delete process.env.SOCIAL_PINTEREST_CLIENT_SECRET;
  try {
    assert.ok(!(await hub(boss)).networks.includes("pinterest"));
    assert.equal((await call(routes.accounts.POST, "POST", "/api/social/accounts", boss, { network: "pinterest" })).status, 404);
  } finally {
    process.env.SOCIAL_PINTEREST_CLIENT_SECRET = PINTEREST.secret;
  }
  const stats = (await adminStats(7)) as { connectors: { social: { open: boolean; networks: Record<string, string[]> } } };
  assert.equal(stats.connectors.social.open, false);
  assert.deepEqual(stats.connectors.social.networks.x, []);
});

test("X: sign-in with state and PKCE, tokens sealed, a post charged first, and a failed post given back", async () => {
  const user = await owner("sh-x");
  const { outcome, page } = await signIn(user, "x");
  assert.equal(outcome, "ok");
  assert.equal(page.searchParams.get("code_challenge_method"), "S256");
  assert.ok(page.searchParams.get("code_challenge"));
  assert.match(page.searchParams.get("scope")!, /offline\.access/);
  assert.equal(log.tokens.at(-1)!.basic, `${X.id}:${X.secret}`);
  const row = await one<{ enc_access: string; enc_refresh: string; account_id: string; name: string }>("SELECT * FROM social_accounts WHERE user_id = ?", [user.id]);
  assert.equal(row!.account_id, "4242");
  assert.equal(row!.name, "@flashshop");
  assert.ok(!row!.enc_access.includes("x-access") && !row!.enc_refresh.includes("x-refresh"), "tokens are sealed");

  const x = await accountOf(user, "x");
  await ensureMonthlyCredits(user.id);
  const before = await balance(user.id);
  const fileId = await picture(user.id);
  const made = await post(user, { text: "New cakes today!", fileId, accountIds: [x.id] });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const sent = (await hub(user)).posts[0].deliveries[0];
  assert.equal(sent.status, "done");
  assert.equal(sent.url, "https://x.com/i/web/status/9001");
  assert.equal(sent.credits, xPostCredits("New cakes today!"));
  assert.equal(await balance(user.id), before - xPostCredits("New cakes today!"));
  assert.deepEqual(log.tweets.at(-1), { text: "New cakes today!", media: { media_ids: ["777"] } });

  // Too long for X: refused before anything is stored.
  const long = await post(user, { text: "a".repeat(281), accountIds: [x.id] });
  assert.equal(long.status, 400);
  assert.match(long.body.error!, /too long for X/);

  // X can't be reached at all: nothing posted, credits given back.
  state.xDown = true;
  const mid = await balance(user.id);
  await post(user, { text: "Second post", accountIds: [x.id] });
  const failed = (await hub(user)).posts[0].deliveries[0];
  assert.equal(failed.status, "failed");
  assert.equal(await balance(user.id), mid);

  // Out of credits: not posted, never sent to X.
  state.xDown = false;
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, 'test', ?)", [user.id, -(await balance(user.id)), Date.now()]);
  const tweets = log.tweets.length;
  await post(user, { text: "Third post", accountIds: [x.id] });
  const broke = (await hub(user)).posts[0].deliveries[0];
  assert.equal(broke.status, "failed");
  assert.equal(broke.problem, "Not enough credits for this X post.");
  assert.equal(log.tweets.length, tweets);
});

test("X: an expired token is renewed once (rotating), a refused renewal asks to reconnect, and mentions are read only when asked, charged by what was read", async () => {
  const user = await owner("sh-x2");
  await signIn(user, "x");
  const x = await accountOf(user, "x");
  await sql("UPDATE social_accounts SET expires_at = ? WHERE id = ?", [Date.now() - 1000, x.id]);
  await ensureMonthlyCredits(user.id);
  const before = await balance(user.id);
  const checked = await call<{ added: number }>(routes.inbox.POST, "POST", "/api/social/inbox", user, { accountId: x.id });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.added, 2);
  assert.equal(await balance(user.id), before - xReadCredits(2));
  assert.equal(log.tokens.filter((t) => t.network === "x" && t.form.grant_type === "refresh_token").length, 1);
  // The free check never reads X.
  const reads = log.mentionReads;
  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  await quiet(() => socialTick());
  assert.equal(log.mentionReads, reads);

  const mention = (await hub(user)).inbox.find((i) => i.network === "x" && i.author === "@dana")!;
  assert.equal(mention.kind, "mention");
  const answered = await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: mention.id, text: "Free over $50!" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(log.tweets.at(-1), { text: "Free over $50!", reply: { in_reply_to_tweet_id: "501" } });
  assert.equal((await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: mention.id, text: "again" })).status, 409);

  state.xRefuseRefresh = true;
  await sql("UPDATE social_accounts SET expires_at = ? WHERE id = ?", [Date.now() - 1000, x.id]);
  await post(user, { text: "Won't go", accountIds: [x.id] });
  assert.equal((await accountOf(user, "x")).status, "needs_reconnect");
});

test("a planned post waits, can be cancelled, goes out on time once, and one whose server stopped mid-way is never sent again", async () => {
  const user = await owner("sh-plan");
  const connected = await call(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "mastodon", server: "mastodon.example", token: "mastodon-token-0123456789" });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  const m = await accountOf(user, "mastodon");
  assert.equal(m.name, "@dana@mastodon.example");

  const soon = await post(user, { text: "Sunday brunch!", accountIds: [m.id], at: Date.now() + 3600_000 });
  assert.equal(soon.status, 200);
  const later = await post(user, { text: "Cancelled one", accountIds: [m.id], at: Date.now() + 7200_000 });
  assert.equal((await hub(user)).posts.find((p) => p.id === later.body.id)!.deliveries[0].status, "waiting");
  await call(routes.posts.DELETE, "DELETE", "/api/social/posts", user, { id: later.body.id });
  assert.equal((await hub(user)).posts.find((p) => p.id === later.body.id)!.deliveries[0].status, "cancelled");

  const toots = log.toots.length;
  await sql("UPDATE social_deliveries SET due_at = ? WHERE post_id IN (?, ?)", [Date.now() - 1000, soon.body.id, later.body.id]);
  await quiet(() => socialTick());
  await quiet(() => socialTick());
  assert.equal(log.toots.length, toots + 1, "sent once, the cancelled one not at all");
  assert.equal(log.toots.at(-1)!.body.status, "Sunday brunch!");
  assert.ok(log.toots.at(-1)!.key, "with an idempotency key");
  assert.equal((await hub(user)).posts.find((p) => p.id === soon.body.id)!.deliveries[0].url, `https://mastodon.example/@dana/${500 + log.toots.length}`);

  // A delivery claimed by a server that stopped: closed as failed, not sent again.
  const stuck = await post(user, { text: "Stuck", accountIds: [m.id], at: Date.now() + 3600_000 });
  await sql("UPDATE social_deliveries SET status = 'posting', lease_until = ? WHERE post_id = ?", [Date.now() - 1000, stuck.body.id]);
  const before = log.toots.length;
  await quiet(() => sendDue());
  const d = (await hub(user)).posts.find((p) => p.id === stuck.body.id)!.deliveries[0];
  assert.equal(d.status, "failed");
  assert.match(d.problem, /Check the account/);
  assert.equal(log.toots.length, before);

  // Mastodon's mentions, and a reply that names who it answers.
  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  const mention = (await hub(user)).inbox.find((i) => i.network === "mastodon")!;
  assert.equal(mention.text, "@dana open on Sunday?");
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: mention.id, text: "Yes, 9 to 2." });
  assert.deepEqual(log.toots.at(-1)!.body, { status: "@lee@other.social Yes, 9 to 2.", in_reply_to_id: "800" });

  // A server that isn't public is refused.
  const bad = await call(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "mastodon", server: "http://10.0.0.1", token: "mastodon-token-0123456789" });
  assert.equal(bad.status, 400);
});

test("Bluesky: app password, a post with a picture and a link, a renewed session, and replies in a thread", async () => {
  const user = await owner("sh-bsky");
  const wrong = await call(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "bluesky", handle: "dana.bsky.social", password: "wrong-pass-word-1234" });
  assert.equal(wrong.status, 400);
  const ok = await call(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "bluesky", handle: "@dana.bsky.social", password: "abcd-efgh-ijkl-mnop" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const b = await accountOf(user, "bluesky");
  const fileId = await picture(user.id);
  await post(user, { text: "Fresh bread https://flash-app.dev #bakery", fileId, accountIds: [b.id] });
  const record = log.bskyRecords.at(-1)!.record as Record<string, unknown>;
  assert.equal((record.embed as Record<string, unknown>).$type, "app.bsky.embed.images");
  assert.equal((record.facets as unknown[]).length, 2);
  assert.match((await hub(user)).posts[0].deliveries[0].url, /^https:\/\/bsky\.app\/profile\/did%3Aplc%3Aabcdefghijklmnop\/post\/3kpost/);

  // A picture over Bluesky's 1 MB is refused before anything is stored.
  const big = await picture(user.id, "image/png", 2 * 1024 * 1024);
  assert.equal((await post(user, { text: "Big", fileId: big, accountIds: [b.id] })).status, 400);

  // The access token ran out: renewed with the refresh token, then the inbox is read (likes left out).
  await sql("UPDATE social_accounts SET expires_at = ? WHERE id = ?", [Date.now() - 1000, b.id]);
  const refreshes = log.bskyRefreshes;
  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  assert.equal(log.bskyRefreshes, refreshes + 1);
  const items = (await hub(user)).inbox.filter((i) => i.network === "bluesky");
  assert.deepEqual(items.map((i) => [i.kind, i.author, i.text]), [["reply", "@sam.bsky.social", "Is it vegan?"]]);
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: items[0].id, text: "Yes!" });
  const reply = (log.bskyRecords.at(-1)!.record as Record<string, unknown>).reply as Record<string, { uri: string }>;
  assert.equal(reply.parent.uri, "at://did:plc:zzz/app.bsky.feed.post/3kreply1");
  assert.equal(reply.root.uri, "at://did:plc:abcdefghijklmnop/app.bsky.feed.post/3kpost1");

  // Its refresh token gone too: Flash signs in again with the app password.
  await sql("UPDATE social_accounts SET expires_at = ?, enc_refresh = enc_access WHERE id = ?", [Date.now() - 1000, b.id]);
  const logins = log.bskyLogins;
  await post(user, { text: "Still posting", accountIds: [b.id] });
  assert.equal(log.bskyLogins, logins + 1);
  assert.equal((await hub(user)).posts[0].deliveries[0].status, "done");
});

test("Telegram: a bot that posts to its channel, messages to it in the inbox (not other groups'), and answers", async () => {
  const user = await owner("sh-tg");
  const missing = await call(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "telegram", token: BOT, chat: "@nochannel" });
  assert.equal(missing.status, 400);
  const ok = await call(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "telegram", token: BOT, chat: "https://t.me/danabakery" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const tg = await accountOf(user, "telegram");
  assert.equal(tg.name, "Dana's Bakery");
  const video = await picture(user.id, "video/mp4", 4096);
  await post(user, { text: "Watch us bake", fileId: video, accountIds: [tg.id] });
  assert.equal(log.tgSent.at(-1)!.method, "sendVideo");
  assert.equal(log.tgSent.at(-1)!.fields.chat_id, "-1001234");
  assert.match((await hub(user)).posts[0].deliveries[0].url, /^https:\/\/t\.me\/danabakery\/\d+$/);

  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  const items = (await hub(user)).inbox.filter((i) => i.network === "telegram");
  assert.deepEqual(items.map((i) => [i.kind, i.author, i.text]), [["message", "Ana", "Do you deliver?"]]);
  assert.equal((await one<{ inbox_cursor: string }>("SELECT inbox_cursor FROM social_accounts WHERE id = ?", [tg.id]))!.inbox_cursor, "702");
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: items[0].id, text: "Yes, in town." });
  assert.equal(log.tgSent.at(-1)!.method, "sendMessage");
  assert.equal(log.tgSent.at(-1)!.fields.chat_id, "555");
  assert.equal(JSON.parse(log.tgSent.at(-1)!.fields.reply_parameters).message_id, 5);
});

test("YouTube and Google Business Profile: one Google app, videos only on YouTube, a location picked, reviews answered", async () => {
  const user = await owner("sh-google");
  const yt = await signIn(user, "youtube");
  assert.equal(yt.outcome, "ok");
  assert.equal(yt.page.searchParams.get("access_type"), "offline");
  assert.match(yt.page.searchParams.get("scope")!, /youtube\.upload/);
  assert.equal(log.tokens.at(-1)!.form.client_secret, GOOGLE.secret, "Google takes the secret in the form");
  const channel = await accountOf(user, "youtube");
  assert.equal(channel.name, "Flash Shop TV");
  const pic = await picture(user.id);
  const refused = await post(user, { text: "No video", fileId: pic, accountIds: [channel.id] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error!, /YouTube needs a video/);
  const video = await picture(user.id, "video/mp4", 8192);
  await post(user, { text: "How we bake", title: "Bakery tour", fileId: video, accountIds: [channel.id] });
  assert.equal((log.uploads.at(-1)!.meta.snippet as Record<string, unknown>).title, "Bakery tour");
  assert.equal((await hub(user)).posts[0].deliveries[0].url, "https://www.youtube.com/watch?v=vid123");

  // Before Google opens its Business Profile API, connecting says so.
  state.gbpOpen = false;
  const closed = await signIn(user, "google-business");
  assert.equal(closed.outcome, "failed");
  assert.match(closed.why!, /^google-business:[\w:.-]+$/, "the owners see Flash's short code for why");
  state.gbpOpen = true;
  assert.equal((await signIn(user, "google-business")).outcome, "ok");
  const biz = await accountOf(user, "google-business");
  assert.equal(biz.targets.length, 2);
  assert.equal(biz.target, "accounts/100/locations/200");
  assert.equal((await call(routes.accounts.PATCH, "PATCH", "/api/social/accounts", user, { id: biz.id, target: "accounts/999/locations/1" })).status, 400);
  await post(user, { text: "Pumpkin bread is back", link: "https://danabakes.example/menu", accountIds: [biz.id] });
  assert.deepEqual(log.localPosts.at(-1), { languageCode: "en", summary: "Pumpkin bread is back", topicType: "STANDARD", callToAction: { actionType: "LEARN_MORE", url: "https://danabakes.example/menu" } });

  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  const inbox = (await hub(user)).inbox;
  const review = inbox.find((i) => i.kind === "review")!;
  assert.equal(review.stars, 4);
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: review.id, text: "Thank you, Lee!" });
  assert.match(log.reviewReplies.at(-1)!.path, /accounts\/100\/locations\/200\/reviews\/r1\/reply$/);
  const comment = inbox.find((i) => i.kind === "comment")!;
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: comment.id, text: "Thanks Ana" });
  assert.deepEqual(log.ytReplies.at(-1), { snippet: { parentId: "c1", textOriginal: "Thanks Ana" } });
});

test("Pinterest: no PKCE, a board picked, a picture and a link; removing an account cancels access where the network can", async () => {
  const user = await owner("sh-pin");
  const { outcome, page } = await signIn(user, "pinterest");
  assert.equal(outcome, "ok");
  assert.equal(page.searchParams.get("scope"), "user_accounts:read,boards:read,pins:read,pins:write");
  assert.equal(page.searchParams.get("code_challenge"), null);
  const pin = await accountOf(user, "pinterest");
  assert.equal(pin.target, "111");
  await call(routes.accounts.PATCH, "PATCH", "/api/social/accounts", user, { id: pin.id, target: "112" });
  assert.equal((await post(user, { text: "Sourdough", accountIds: [pin.id] })).status, 400, "a Pin needs a picture");
  const pic = await picture(user.id, "image/jpeg");
  await post(user, { text: "Sourdough loaf", title: "Sourdough", link: "https://danabakes.example", fileId: pic, accountIds: [pin.id] });
  const sent = log.pins.at(-1)!;
  assert.equal(sent.board_id, "112");
  assert.equal(sent.link, "https://danabakes.example");
  assert.equal((sent.media_source as Record<string, unknown>).source_type, "image_base64");

  // Someone else's account can't be touched; the owner's own removal goes.
  const other = await owner("sh-pin-other");
  assert.equal((await call(routes.accounts.DELETE, "DELETE", "/api/social/accounts", other, { id: pin.id })).status, 404);
  await call(routes.accounts.DELETE, "DELETE", "/api/social/accounts", user, { id: pin.id });
  assert.equal((await hub(user)).accounts.length, 0);
  assert.equal((await all("SELECT * FROM social_posts WHERE user_id = ?", [user.id])).length, 0);

  const xUser = await owner("sh-x-remove");
  await signIn(xUser, "x");
  const x = await accountOf(xUser, "x");
  const revoked = log.revoked.length;
  await call(routes.accounts.DELETE, "DELETE", "/api/social/accounts", xUser, { id: x.id });
  assert.equal(log.revoked.length, revoked + 1);
  assert.match(log.revoked.at(-1)!, /^x-refresh-/);
});

test("a sign-in is finished only by the account that started it, once", async () => {
  const user = await owner("sh-state");
  const thief = await owner("sh-thief");
  const started = await call<{ url: string }>(routes.accounts.POST, "POST", "/api/social/accounts", user, { network: "x" });
  const page = await fetch(started.body.url, { redirect: "manual" });
  const back = new URL(page.headers.get("location")!);
  const stolen = await quiet(() => routes.callback.GET(new Request(back.href, { headers: { cookie: thief.cookie } })));
  assert.equal(new URL(stolen.headers.get("location")!).searchParams.get("social"), "expired");
  assert.equal((await hub(thief)).accounts.length, 0);
  const mine = await quiet(() => routes.callback.GET(new Request(back.href, { headers: { cookie: user.cookie } })));
  assert.equal(new URL(mine.headers.get("location")!).searchParams.get("social"), "ok");
  const again = await quiet(() => routes.callback.GET(new Request(back.href, { headers: { cookie: user.cookie } })));
  assert.equal(new URL(again.headers.get("location")!).searchParams.get("social"), "expired");
});

test("Facebook: Pages picked from the sign-in, only each Page's own token kept, posts, comments and messages answered", async () => {
  const user = await owner("sh-fb");
  // A wrong app secret: the owners see the step and Meta's error number.
  process.env.SOCIAL_META_APP_SECRET = "not-the-secret";
  assert.equal((await signIn(user, "facebook")).why, "facebook:token:code:http400:100");
  process.env.SOCIAL_META_APP_SECRET = META.secret;
  // Only a business portfolio's Page: found from the Pages picked at sign-in.
  state.fbBusinessPages = true;
  assert.equal((await signIn(user, "facebook")).outcome, "ok");
  assert.deepEqual((await accountOf(user, "facebook")).targets.map((t) => t.id), ["602"]);
  state.fbBusinessPages = false;
  await sql("DELETE FROM social_accounts WHERE user_id = ?", [user.id]);
  const { outcome, page } = await signIn(user, "facebook");
  assert.equal(outcome, "ok");
  assert.equal(page.searchParams.get("scope"), "pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content,pages_manage_engagement");
  assert.equal(page.searchParams.get("code_challenge"), null);
  assert.equal(log.metaTokens.at(-1)!.params.grant_type, "fb_exchange_token", "traded for a 60-day token");
  const row = await one<{ account_id: string; enc_access: string; enc_refresh: string; enc_secret: string }>("SELECT * FROM social_accounts WHERE user_id = ?", [user.id]);
  assert.equal(row!.account_id, "10001");
  assert.equal(row!.enc_access, "", "the person's own token isn't kept");
  assert.ok(!row!.enc_secret.includes("fbpagetoken"), "Page tokens are sealed");
  const fb = await accountOf(user, "facebook");
  assert.deepEqual(fb.targets.map((t) => t.id), ["601", "602"]);
  assert.equal(fb.target, "601");

  await post(user, { text: "Croissants at 7", link: "https://danabakes.example", accountIds: [fb.id] });
  assert.deepEqual(log.meta.at(-1), { path: "facebook/601/feed", token: PAGE_TOKENS["601"], fields: { message: "Croissants at 7", link: "https://danabakes.example" }, json: {} });
  assert.equal((await hub(user)).posts[0].deliveries[0].url, "https://www.facebook.com/601/posts/7001");

  await call(routes.accounts.PATCH, "PATCH", "/api/social/accounts", user, { id: fb.id, target: "602" });
  const pic = await picture(user.id);
  await post(user, { text: "New cafe menu", fileId: pic, accountIds: [fb.id] });
  assert.equal(log.meta.at(-1)!.path, "facebook/602/photos");
  assert.equal(log.meta.at(-1)!.token, PAGE_TOKENS["602"]);
  assert.match(log.meta.at(-1)!.fields.source, /^file:/);
  assert.equal((await hub(user)).posts[0].deliveries[0].url, "https://www.facebook.com/602/posts/7002");

  await call(routes.accounts.PATCH, "PATCH", "/api/social/accounts", user, { id: fb.id, target: "601" });
  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  const items = (await hub(user)).inbox.filter((i) => i.network === "facebook");
  assert.deepEqual(items.map((i) => [i.kind, i.author, i.text]).sort(), [["comment", "Ana", "Open today?"], ["message", "Lee", "Do you cater?"]]);
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: items.find((i) => i.kind === "comment")!.id, text: "Until 6!" });
  assert.deepEqual(log.meta.at(-1)!.fields, { message: "Until 6!" });
  assert.equal(log.meta.at(-1)!.path, "facebook/7001_91/comments");
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: items.find((i) => i.kind === "message")!.id, text: "Yes, we do." });
  assert.deepEqual(log.meta.at(-1)!.json, { recipient: { id: "444" }, messaging_type: "RESPONSE", message: { text: "Yes, we do." } });
});

test("Instagram: a professional account, JPG pictures only, the file shared publicly only while Instagram fetches it, renewed in its last week", async () => {
  const user = await owner("sh-ig");
  assert.equal((await signIn(user, "instagram")).outcome, "ok");
  const ig = await accountOf(user, "instagram");
  assert.equal(ig.name, "@danabakes");
  assert.equal((await one<{ account_id: string }>("SELECT account_id FROM social_accounts WHERE id = ?", [ig.id]))!.account_id, "17841400000000001");

  const words = await post(user, { text: "Only words", accountIds: [ig.id] });
  assert.equal(words.status, 400);
  assert.match(words.body.error!, /Instagram needs a picture or video/);
  const png = await picture(user.id, "image/png");
  assert.match((await post(user, { text: "PNG", fileId: png, accountIds: [ig.id] })).body.error!, /JPG pictures only/);

  const jpg = await picture(user.id, "image/jpeg");
  await post(user, { text: "Fresh rye", fileId: jpg, accountIds: [ig.id] });
  const fetched = log.mediaUrls.at(-1)!;
  assert.match(fetched.url, /^http:\/\/flash\.test\/f\/[\w-]+$/);
  assert.ok(fetched.shared, "public while Instagram fetches it");
  assert.equal(await one("SELECT 1 FROM public_files WHERE id = ?", [fetched.url.split("/f/")[1]]), null, "and not after");
  assert.equal(log.meta.at(-1)!.path, "instagram/17841400000000001/media_publish");
  assert.equal((await hub(user)).posts[0].deliveries[0].url, "https://www.instagram.com/p/ABC123/");

  // Six days left: renewed with itself before it is used.
  await sql("UPDATE social_accounts SET expires_at = ? WHERE id = ?", [Date.now() + 6 * 86_400_000, ig.id]);
  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  assert.equal(log.metaTokens.at(-1)!.params.grant_type, "ig_refresh_token");
  assert.ok(Number((await one<{ expires_at: number }>("SELECT expires_at FROM social_accounts WHERE id = ?", [ig.id]))!.expires_at) > Date.now() + 50 * 86_400_000);
  const items = (await hub(user)).inbox.filter((i) => i.network === "instagram");
  assert.deepEqual(items.map((i) => [i.kind, i.author, i.text]).sort(), [["comment", "@sam", "Yum!"], ["message", "@ana_k", "Price?"]]);
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: items.find((i) => i.kind === "message")!.id, text: "$8" });
  assert.deepEqual(log.meta.at(-1)!.json, { recipient: { id: "555" }, message: { text: "$8" } });
});

test("Threads: words with a link, replies read and answered; Meta's signed deauthorize and deletion requests", async () => {
  const user = await owner("sh-th");
  assert.equal((await signIn(user, "threads")).outcome, "ok");
  const th = await accountOf(user, "threads");
  await post(user, { text: "Bake sale Saturday", link: "https://danabakes.example/sale", accountIds: [th.id] });
  const made = log.meta.find((m) => m.path === "threads/2600000000000009/threads" && m.fields.text === "Bake sale Saturday")!;
  assert.deepEqual(made.fields, { text: "Bake sale Saturday", media_type: "TEXT", link_attachment: "https://danabakes.example/sale" });
  assert.equal((await hub(user)).posts[0].deliveries[0].url, "https://www.threads.net/@danabakes/post/XYZ");
  assert.equal((await post(user, { text: "a".repeat(501), accountIds: [th.id] })).status, 400);

  await call(routes.inbox.POST, "POST", "/api/social/inbox", user, {});
  const items = (await hub(user)).inbox.filter((i) => i.network === "threads");
  assert.deepEqual(items.map((i) => [i.kind, i.author, i.text]), [["reply", "@lee", "Gluten free?"]]);
  await call(routes.reply.POST, "POST", "/api/social/inbox/reply", user, { id: items[0].id, text: "Not yet" });
  assert.equal(log.meta.filter((m) => m.path === "threads/2600000000000009/threads").at(-1)!.fields.reply_to_id, "1800050");

  // Meta's requests, signed with the app's secret.
  const signed = (secret: string, userId: string) => {
    const payload = b64url(Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: 1 })));
    return `${b64url(createHmac("sha256", secret).update(payload).digest())}.${payload}`;
  };
  const metaPost = (handler: (r: Request) => Promise<Response>, value: string) => quiet(() => handler(new Request(`${ORIGIN}/api/social/meta`, { method: "POST", body: new URLSearchParams({ signed_request: value }) })));
  assert.equal((await metaPost(routes.metaDelete.POST, signed("not-the-secret", "2600000000000009"))).status, 400);
  const fbUser = await owner("sh-th-fb");
  await signIn(fbUser, "facebook");
  assert.equal((await metaPost(routes.metaDeauthorize.POST, signed(META.secret, "10001"))).status, 204);
  assert.equal((await accountOf(fbUser, "facebook")).status, "needs_reconnect");
  const deleted = await metaPost(routes.metaDelete.POST, signed(THREADS.secret, "2600000000000009"));
  assert.equal(deleted.status, 200);
  const answer = (await deleted.json()) as { url: string; confirmation_code: string };
  assert.ok(answer.confirmation_code && answer.url.includes(answer.confirmation_code));
  assert.equal((await hub(user)).accounts.filter((a) => a.network === "threads").length, 0);
  assert.equal((await hub(fbUser)).accounts.length, 1, "a Threads secret deletes only Threads accounts");
});
