import { isAdmin, type User } from "./auth.ts";
import { charge, ensureMonthlyCredits, settle } from "./credits.ts";
import { all, db, now, one, run } from "./db.ts";
import { readFile } from "./files.ts";
import { randomId } from "./ids.ts";
import { overLimit } from "./limits.ts";
import { OAuthError } from "./mcp-oauth.ts";
import { connectorsReady, seal, unseal, type SecretPlace } from "./secret-box.ts";
import {
  BOT_TOKEN,
  HANDLE,
  MEDIA_LIMITS,
  PICTURE_TYPES,
  PROBLEMS,
  SocialError,
  VIDEO_TYPES,
  blueskyLogin,
  blueskyRefresh,
  lookupAccount,
  mastodonServer,
  publish,
  readInbox,
  reply as replyOn,
  type Ctx,
  type Found,
  type Media,
} from "./social-networks.ts";
import {
  beginSocialFlow,
  exchangeSocialCode,
  googleSub,
  isMetaNetwork,
  isSigninNetwork,
  refreshSocialToken,
  revokeSocialToken,
  signinMissing,
  signinReady,
  takeSocialFlow,
  SIGNIN_NETWORKS,
  type SigninNetwork,
} from "./social-signin.ts";
import {
  MAX_AHEAD_MS,
  MAX_SCHEDULED,
  MAX_SOCIAL_ACCOUNTS,
  NETWORKS,
  TELEGRAM_CAPTION,
  isNetworkId,
  networkById,
  textLength,
  xMentionsCredits,
  xPostCredits,
  xReadCredits,
  type InboxItemView,
  type KeyConnect,
  type NetworkId,
  type SocialAccountView,
  type SocialPostView,
} from "../social.ts";
import { msg } from "../i18n.ts";

/*
 * The Social hub's accounts, posts and inbox (see ../social.ts for the networks). Everything is by
 * user id: a user only ever sees and uses their own accounts. Tokens are sealed with CONNECTOR_KEYS
 * (secret-box.ts), bound to the account's row, user and network, and opened only to call that
 * network. Logs carry ids, networks and outcomes, never what was posted or a token.
 *
 * Posting: a post is stored with one delivery per account, due now or at the time picked. A
 * delivery is claimed once ('posting', with a lease) and sent once: one whose server stopped mid-way
 * (its lease ran out) is closed as failed, never sent again by itself, since the network may have it.
 * Mastodon also takes an idempotency key. The per-minute social tick (api/cron/social) sends what is
 * due and reads the inboxes.
 *
 * Instagram and Threads fetch a post's picture or video themselves: Flash makes a public address for
 * that one file (/f/<id>, the same as a connected app's) just before posting, and takes it away after.
 *
 * Money: X's API is paid per post and per read. Each X post or reply is charged in credits before X
 * is asked (MARKUP times X's price, see ../social.ts) and given back when X surely didn't take it;
 * reading X mentions happens only when the user asks, with the most it can cost held first and the
 * rest given back. Every other network costs Flash nothing.
 *
 * It is tried out by Flash's owners first: until FLASH_SOCIAL_OPEN is "true", only admins see it.
 */

const env = (name: string) => process.env[name]?.trim() ?? "";
export const socialOpen = () => env("FLASH_SOCIAL_OPEN") === "true";
/** Whether this user sees the Social hub: connectors can keep secrets, and it's open or they're an owner. */
export const socialOpenTo = (user: Pick<User, "email" | "verified_at">) => connectorsReady() && (socialOpen() || isAdmin(user));

/** Whether a network can be connected now (a sign-in network needs Flash's app there). */
export const networkReady = (id: NetworkId) => connectorsReady() && (isSigninNetwork(id) ? signinReady(id) : true);
export const readyNetworks = () => NETWORKS.filter((n) => networkReady(n.id)).map((n) => n.id);

/** For /admin: each sign-in network's variables still missing (names only), and whether it's open to everyone. */
export const socialSetup = () => ({
  open: socialOpen(),
  keys: connectorsReady(),
  networks: Object.fromEntries(SIGNIN_NETWORKS.map((n) => [n, signinMissing(n)])) as Record<SigninNetwork, string[]>,
});

/** A problem the user can fix, in Flash's words (a msg() phrase, shown with t()), with its blanks. */
export class SocialInputError extends Error {
  status: number;
  values: Record<string, string | number>;
  constructor(message: string, status = 400, values: Record<string, string | number> = {}) {
    super(message);
    this.status = status;
    this.values = values;
  }
}

const HOUR = 60 * 60_000;
const NOT_FOUND = msg("That account isn't connected any more.");

type AccountRow = {
  id: string;
  user_id: string;
  network: NetworkId;
  account_id: string;
  name: string;
  status: "ok" | "needs_reconnect";
  enc_secret: string;
  enc_access: string;
  enc_refresh: string;
  expires_at: number;
  refreshing_until: number | null;
  server: string;
  targets: string;
  target: string;
  inbox_cursor: string;
  inbox_at: number;
  created_at: number;
};

const place = (row: Pick<AccountRow, "id" | "user_id" | "network">, field: "secret" | "access" | "refresh"): SecretPlace => ({
  id: row.id,
  userId: row.user_id,
  provider: `social-${row.network}`,
  field,
});

const targetsOf = (row: Pick<AccountRow, "targets">): { id: string; name: string }[] => {
  try {
    const list: unknown = JSON.parse(row.targets);
    return Array.isArray(list) ? list.filter((t) => t && typeof t.id === "string" && typeof t.name === "string").slice(0, 100) : [];
  } catch {
    return [];
  }
};

function view(row: AccountRow): SocialAccountView {
  return { id: row.id, network: row.network, name: row.name, status: row.status === "ok" ? "ok" : "needs_reconnect", targets: targetsOf(row), target: row.target, createdAt: Number(row.created_at) };
}

const accountRows = async (userId: string) => (await all<AccountRow>("SELECT * FROM social_accounts WHERE user_id = ? ORDER BY created_at", [userId])).filter((r) => isNetworkId(r.network) && networkReady(r.network));

export async function listAccounts(userId: string): Promise<SocialAccountView[]> {
  return (await accountRows(userId)).map(view);
}

async function owned(userId: string, id: string): Promise<AccountRow> {
  const row = typeof id === "string" && /^[\w-]{8,40}$/.test(id) ? await one<AccountRow>("SELECT * FROM social_accounts WHERE id = ? AND user_id = ?", [id, userId]) : null;
  if (!row || !isNetworkId(row.network)) throw new SocialInputError(NOT_FOUND, 404);
  return row;
}

/**
 * Keeps an account the user just connected: the same account again (by the network's own id) is
 * updated in place, with its new secrets; a new one is added, up to MAX_SOCIAL_ACCOUNTS.
 */
async function keep(userId: string, network: NetworkId, found: Found, secrets: { secret?: string; access?: string; refresh?: string; expiresAt?: number }): Promise<SocialAccountView> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await one<AccountRow>("SELECT * FROM social_accounts WHERE user_id = ? AND network = ? AND account_id = ?", [userId, network, found.accountId]);
    const where = existing ?? { id: randomId(12), user_id: userId, network };
    const sealed = (value: string | undefined, field: "secret" | "access" | "refresh") => (value ? seal(value, place(where, field)) : null);
    const secret = sealed(secrets.secret, "secret");
    const access = sealed(secrets.access, "access");
    const refresh = sealed(secrets.refresh, "refresh");
    const version = (secret ?? access ?? refresh)?.version ?? "";
    const targets = JSON.stringify(found.targets.slice(0, 100));
    const stillThere = (t: string) => found.targets.some((x) => x.id === t);
    if (existing) {
      await run(
        `UPDATE social_accounts SET name = ?, status = 'ok', enc_secret = ?, enc_access = ?, enc_refresh = ?, expires_at = ?, refreshing_until = NULL,
           key_version = ?, server = ?, targets = ?, target = ? WHERE id = ? AND user_id = ?`,
        [
          found.name,
          secret?.stored ?? "",
          access?.stored ?? "",
          refresh?.stored ?? "",
          secrets.expiresAt ?? 0,
          version,
          found.server ?? "",
          targets,
          stillThere(existing.target) ? existing.target : (found.targets[0]?.id ?? ""),
          existing.id,
          userId,
        ],
      );
      return view((await one<AccountRow>("SELECT * FROM social_accounts WHERE id = ?", [existing.id]))!);
    }
    const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM social_accounts WHERE user_id = ?", [userId]);
    if (Number(count?.n ?? 0) >= MAX_SOCIAL_ACCOUNTS) throw new SocialInputError(msg("You have the most social accounts Flash keeps. Remove one first."), 409);
    const added = await run(
      `INSERT INTO social_accounts (id, user_id, network, account_id, name, status, enc_secret, enc_access, enc_refresh, expires_at, key_version, server, targets, target, created_at)
       VALUES (?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, network, account_id) DO NOTHING`,
      [where.id, userId, network, found.accountId, found.name, secret?.stored ?? "", access?.stored ?? "", refresh?.stored ?? "", secrets.expiresAt ?? 0, version, found.server ?? "", targets, found.targets[0]?.id ?? "", now()],
    );
    if (added.rowsAffected) return view((await one<AccountRow>("SELECT * FROM social_accounts WHERE id = ?", [where.id]))!);
  }
  throw new SocialInputError(NOT_FOUND, 409);
}

/** Why a network said no to connecting, in Flash's words. */
const connectProblem = (err: unknown) => (err instanceof SocialError ? err.message : PROBLEMS.unreachable);

/** Connects Bluesky, Mastodon or Telegram with what the user made there. Checked with the network before anything is kept. */
export async function connectWithKey(userId: string, input: KeyConnect): Promise<SocialAccountView> {
  if (await overLimit(`social-connect:${userId}`, 20, HOUR)) throw new SocialInputError(msg("Too many attempts. Try again in an hour."), 429);
  try {
    if (input.network === "bluesky") {
      const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
      const password = input.password.trim();
      if (!HANDLE.test(handle) || !/^[\w-]{4,64}$/.test(password)) throw new SocialInputError(msg("Type your Bluesky handle and an app password."));
      const session = await blueskyLogin(handle, password);
      return await keep(userId, "bluesky", { accountId: session.did, name: `@${session.handle || handle}`, targets: [], server: handle }, { secret: password, access: session.access, refresh: session.refresh, expiresAt: session.expiresAt });
    }
    if (input.network === "mastodon") {
      const server = mastodonServer(input.server);
      const token = input.token.trim();
      if (!server || !/^[\w.~+/=-]{10,200}$/.test(token)) throw new SocialInputError(msg("Type your Mastodon server, like mastodon.social, and an access token."));
      const found = await lookupAccount("mastodon", token, { server });
      return await keep(userId, "mastodon", found, { secret: token });
    }
    if (input.network === "telegram") {
      const token = input.token.trim();
      const chat = input.chat.trim().replace(/^https:\/\/t\.me\//, "@");
      if (!BOT_TOKEN.test(token) || !/^(@[A-Za-z]\w{3,31}|-?\d{1,20})$/.test(chat)) throw new SocialInputError(msg("Type your bot's token from BotFather and your channel, like @mychannel."));
      const found = await lookupAccount("telegram", token, { chat });
      return await keep(userId, "telegram", found, { secret: token });
    }
  } catch (err) {
    if (err instanceof SocialInputError) throw err;
    console.log(`[flash] social connect ${input.network} failed: ${err instanceof SocialError ? err.code : "error"}`);
    throw new SocialInputError(connectProblem(err), 400);
  }
  throw new SocialInputError(msg("Unknown network."));
}

/** Connect for X, YouTube, Google Business Profile or Pinterest: the network's sign-in page. */
export async function startSignin(userId: string, network: SigninNetwork, origin: string): Promise<string> {
  if (await overLimit(`social-connect:${userId}`, 20, HOUR)) throw new SocialInputError(msg("Too many attempts. Try again in an hour."), 429);
  const count = await one<{ n: number }>("SELECT COUNT(*) AS n FROM social_accounts WHERE user_id = ?", [userId]);
  if (Number(count?.n ?? 0) >= MAX_SOCIAL_ACCOUNTS) throw new SocialInputError(msg("You have the most social accounts Flash keeps. Remove one first."), 409);
  return beginSocialFlow(network, userId, origin);
}

export type SigninOutcome = "ok" | "cancelled" | "expired" | "failed";

/**
 * The networks' callback: trades a code only for a flow this user started (taken once by its
 * state), with its network and PKCE verifier. The account is the one the network names for the new
 * token, never anything in the callback's address. Tokens that can't be kept are given back where
 * the network allows it.
 */
export async function finishSignin(userId: string, params: { state: string | null; code: string | null; error: string | null }): Promise<{ outcome: SigninOutcome; network?: SigninNetwork }> {
  const flow = await takeSocialFlow(userId, params.state).catch(() => null);
  if (!flow) return { outcome: "expired" };
  const { network } = flow;
  const failed = (why: string) => {
    console.log(`[flash] social sign-in ${network} failed: ${why}`);
    return { outcome: "failed" as const, network };
  };
  if (params.error) return { outcome: "cancelled", network };
  if (!params.code) return failed("no code");
  let tokens;
  try {
    tokens = await exchangeSocialCode(network, params.code, flow.verifier, flow.redirectUri);
  } catch (err) {
    return failed(err instanceof OAuthError ? err.code : "token");
  }
  try {
    const sub = network === "youtube" || network === "google-business" ? googleSub(tokens.idToken) : "";
    if ((network === "youtube" || network === "google-business") && !sub) throw new SocialError("refused", PROBLEMS.refused);
    const found = await lookupAccount(network, tokens.access, { sub });
    // Facebook: only each Page's own token is kept (found.secret), never the person's.
    if (network === "facebook") await keep(userId, network, found, { secret: found.secret });
    else await keep(userId, network, found, { access: tokens.access, refresh: tokens.refresh, expiresAt: tokens.expiresAt });
    console.log(`[flash] social sign-in ${network} ok`);
    return { outcome: "ok", network };
  } catch (err) {
    await revokeSocialToken(network, tokens.refresh || tokens.access);
    return failed(err instanceof SocialError ? err.code : err instanceof SocialInputError ? "kept" : "store");
  }
}

/** Removes an account, with its scheduled posts there and its inbox. Flash's access is cancelled where the network allows it. */
export async function removeAccount(userId: string, id: string): Promise<void> {
  const row = await owned(userId, id);
  if (isSigninNetwork(row.network)) {
    let token = "";
    try {
      token = row.enc_refresh ? unseal(row.enc_refresh, place(row, "refresh")) : row.enc_access ? unseal(row.enc_access, place(row, "access")) : "";
    } catch {
      token = "";
    }
    if (token) console.log(`[flash] social ${row.id} ${row.network} revoke ${(await revokeSocialToken(row.network, token)) ? "ok" : "not confirmed"}`);
  }
  await (await db()).batch(
    [
      { sql: "DELETE FROM social_accounts WHERE id = ? AND user_id = ?", args: [id, userId] },
      // A post whose every account was removed has nothing left to show.
      { sql: "DELETE FROM social_posts WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM social_deliveries d WHERE d.post_id = social_posts.id)", args: [userId] },
    ],
    "write",
  );
}

/** Picks where an account posts: one of its boards or locations. */
export async function pickTarget(userId: string, id: string, target: string): Promise<SocialAccountView> {
  const row = await owned(userId, id);
  if (!targetsOf(row).some((t) => t.id === target)) throw new SocialInputError(msg("That board or place isn't one of this account's."));
  await run("UPDATE social_accounts SET target = ? WHERE id = ? AND user_id = ?", [target, id, userId]);
  return view({ ...row, target });
}

// ------------------------------------------------------------------------------------- Tokens

const RENEW_EARLY_MS = 60_000;
// Instagram's and Threads' 60-day tokens are renewed in their last week (only a token a day old can be).
const META_RENEW_EARLY_MS = 7 * 86_400_000;
const RENEW_LOCK_MS = 30_000;
const RENEW_WAIT_MS = 15_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const needsReconnect = (row: AccountRow) => run("UPDATE social_accounts SET status = 'needs_reconnect', refreshing_until = NULL WHERE id = ?", [row.id]);

/** What an account is called with: its key, or its access token, renewed first when it runs out within a minute (one renewal at a time). */
async function contextFor(first: AccountRow): Promise<Ctx> {
  let row: AccountRow | null = first;
  const until = Date.now() + RENEW_WAIT_MS;
  for (;;) {
    if (!row || row.status !== "ok") throw new SocialError("auth", PROBLEMS.auth);
    const ctx = (token: string): Ctx => ({ network: row!.network, token, accountId: row!.account_id, server: row!.server, target: row!.target });
    const open = (stored: string, field: "secret" | "access" | "refresh") => {
      try {
        return unseal(stored, place(row!, field));
      } catch {
        throw new SocialError("auth", PROBLEMS.auth);
      }
    };
    if (row.network === "mastodon" || row.network === "telegram") return ctx(open(row.enc_secret, "secret"));
    if (row.network === "facebook") {
      // Each Page's own token, for the Page posts go to.
      let pages: Record<string, unknown> = {};
      try {
        pages = JSON.parse(open(row.enc_secret, "secret")) as Record<string, unknown>;
      } catch {
        throw new SocialError("auth", PROBLEMS.auth);
      }
      const token = pages[row.target];
      if (typeof token !== "string" || !token) throw new SocialError("auth", PROBLEMS.auth);
      return ctx(token);
    }
    const expires = Number(row.expires_at);
    const early = isMetaNetwork(row.network) ? META_RENEW_EARLY_MS : RENEW_EARLY_MS;
    if (row.enc_access && !(expires > 0 && expires - early < now())) return ctx(open(row.enc_access, "access"));
    const at = now();
    const took = await run(
      "UPDATE social_accounts SET refreshing_until = ? WHERE id = ? AND status = 'ok' AND enc_access = ? AND (refreshing_until IS NULL OR refreshing_until < ?)",
      [at + RENEW_LOCK_MS, row.id, row.enc_access, at],
    );
    if (took.rowsAffected) {
      try {
        return ctx(await renew(row, open));
      } catch (err) {
        // A Meta token in its last week still works: renewing is tried again on the next call.
        if (isMetaNetwork(row.network) && err instanceof SocialError && err.code === "unreachable" && expires > now()) return ctx(open(row.enc_access, "access"));
        throw err;
      }
    }
    if (Date.now() > until) throw new SocialError("unreachable", PROBLEMS.unreachable);
    await pause(200);
    row = await one<AccountRow>("SELECT * FROM social_accounts WHERE id = ?", [first.id]);
  }
}

/**
 * Renews an account's tokens, holding its renewal. The new tokens are kept in one write before use
 * (X and Pinterest may send a new refresh token and stop taking the old one). Bluesky signs in again
 * with its app password when its refresh token has run out. A refusal marks the account for
 * Reconnect; anything else frees the renewal and says the network couldn't be reached.
 */
async function renew(row: AccountRow, open: (stored: string, field: "secret" | "access" | "refresh") => string): Promise<string> {
  const free = () => run("UPDATE social_accounts SET refreshing_until = NULL WHERE id = ?", [row.id]);
  let tokens: { access: string; refresh: string; expiresAt: number };
  try {
    if (row.network === "bluesky") {
      try {
        tokens = await blueskyRefresh(open(row.enc_refresh, "refresh"));
      } catch (err) {
        if (!(err instanceof SocialError) || (err.code !== "auth" && err.code !== "refused")) throw err;
        tokens = await blueskyLogin(row.server || row.name.replace(/^@/, ""), open(row.enc_secret, "secret"));
      }
    } else if (isSigninNetwork(row.network) && row.enc_refresh) {
      tokens = await refreshSocialToken(row.network, open(row.enc_refresh, "refresh"));
    } else {
      throw new SocialError("auth", PROBLEMS.auth);
    }
  } catch (err) {
    if ((err instanceof SocialError && err.code === "auth") || (err instanceof OAuthError && err.code === "invalid_grant")) {
      await needsReconnect(row);
      console.log(`[flash] social ${row.id} ${row.network} renewal refused`);
      throw new SocialError("auth", PROBLEMS.auth);
    }
    await free();
    console.log(`[flash] social ${row.id} ${row.network} renewal failed`);
    throw new SocialError("unreachable", PROBLEMS.unreachable);
  }
  const access = seal(tokens.access, place(row, "access"));
  const refresh = tokens.refresh ? seal(tokens.refresh, place(row, "refresh")).stored : row.enc_refresh;
  await run("UPDATE social_accounts SET enc_access = ?, enc_refresh = ?, expires_at = ?, refreshing_until = NULL, key_version = ? WHERE id = ? AND enc_access = ?", [
    access.stored,
    refresh,
    tokens.expiresAt,
    access.version,
    row.id,
    row.enc_access,
  ]);
  return tokens.access;
}

// -------------------------------------------------------------------------------------- Posts

export type NewPost = { text: string; title?: string; link?: string; fileId?: string; accountIds: string[]; at?: number };

const kindOf = (mime: string) => (PICTURE_TYPES.test(mime) ? "picture" : VIDEO_TYPES.test(mime) ? "video" : "");

/**
 * Stores a post with one delivery per account, after checking it fits every network it goes to.
 * Due now (sent at once, see sendDue) or at the time picked, up to a year ahead.
 */
export async function createPost(userId: string, input: NewPost): Promise<{ id: string; dueNow: boolean }> {
  const text = String(input.text ?? "").replace(/\r\n/g, "\n").trim();
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim();
  const link = String(input.link ?? "").trim();
  const ids = [...new Set(Array.isArray(input.accountIds) ? input.accountIds.filter((x) => typeof x === "string") : [])].slice(0, MAX_SOCIAL_ACCOUNTS);
  if (!ids.length) throw new SocialInputError(msg("Pick at least one account."));
  if (!text || text.length > 5000) throw new SocialInputError(msg("Write the post first."));
  if (title.length > 100) throw new SocialInputError(msg("The title can be at most {max} characters."), 400, { max: 100 });
  if (link && !/^https:\/\/[^\s<>"]{3,2000}$/.test(link)) throw new SocialInputError(msg("The link must start with https://."));
  const time = now();
  const at = Number(input.at) || 0;
  if (at && (at < time - 5 * 60_000 || at > time + MAX_AHEAD_MS)) throw new SocialInputError(msg("Pick a time from now to a year ahead."));
  const due = Math.max(at, time);
  if (await overLimit(`social-post:${userId}`, 60, HOUR)) throw new SocialInputError(msg("Too many posts in an hour. Try again later."), 429);

  const accounts = await Promise.all(ids.map((id) => owned(userId, id)));
  let file: { mime: string; name: string; size: number } | null = null;
  if (input.fileId) {
    const found = /^[\w-]{10,40}$/.test(input.fileId) ? await readFile(input.fileId, userId) : null;
    if (!found || !kindOf(found.mime)) throw new SocialInputError(msg("Pick a picture or video from My creations."));
    file = { mime: found.mime, name: found.name, size: found.data.byteLength };
  }
  const kind = file ? kindOf(file.mime) : "";
  for (const a of accounts) {
    const network = networkById(a.network)!;
    const values = { network: network.name };
    if (a.status !== "ok" || !networkReady(a.network)) throw new SocialInputError(msg("Connect {network} again before posting there."), 400, values);
    const max = a.network === "telegram" && file ? TELEGRAM_CAPTION : network.maxText;
    if (textLength(a.network, text) > max) throw new SocialInputError(msg("This is too long for {network}: at most {max} characters."), 400, { ...values, max });
    if (network.needs === "video" && kind !== "video") throw new SocialInputError(msg("{network} needs a video from My creations."), 400, values);
    if (network.needs === "picture" && kind !== "picture") throw new SocialInputError(msg("{network} needs a picture from My creations."), 400, values);
    if (network.needs === "media" && !kind) throw new SocialInputError(msg("{network} needs a picture or video from My creations."), 400, values);
    if (a.network === "instagram" && kind === "picture" && file && file.mime !== "image/jpeg") throw new SocialInputError(msg("{network} takes JPG pictures only."), 400, values);
    if (kind && !network.media.includes(kind as "picture" | "video")) throw new SocialInputError(msg("{network} can't take this file. Post there without it."), 400, values);
    if (file && file.size > MEDIA_LIMITS[a.network][kind as "picture" | "video"]) throw new SocialInputError(msg("The file is too large for {network}."), 400, values);
    if (a.network === "pinterest" && file && !/^image\/(png|jpeg)$/.test(file.mime)) throw new SocialInputError(msg("{network} takes PNG and JPG pictures only."), 400, values);
    if ((a.network === "google-business" || a.network === "pinterest" || a.network === "facebook") && !a.target) throw new SocialInputError(msg("Pick where {network} posts go first."), 400, values);
  }
  const waiting = await one<{ n: number }>("SELECT COUNT(*) AS n FROM social_deliveries WHERE user_id = ? AND status = 'waiting'", [userId]);
  if (Number(waiting?.n ?? 0) + accounts.length > MAX_SCHEDULED) throw new SocialInputError(msg("You have {max} posts waiting already. Cancel some first."), 409, { max: MAX_SCHEDULED });

  const id = randomId(12);
  await (await db()).batch(
    [
      {
        sql: "INSERT INTO social_posts (id, user_id, text, title, link, file_id, file_name, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [id, userId, text, title, link, input.fileId && file ? input.fileId : "", file?.name.slice(0, 200) ?? "", due, time],
      },
      ...accounts.map((a) => ({
        sql: "INSERT INTO social_deliveries (id, post_id, user_id, account_id, network, status, due_at) VALUES (?, ?, ?, ?, ?, 'waiting', ?)",
        args: [randomId(12), id, userId, a.id, a.network, due],
      })),
    ],
    "write",
  );
  return { id, dueNow: due <= time };
}

/** Cancels what of a post hasn't gone out yet. */
export async function cancelPost(userId: string, postId: string): Promise<number> {
  const done = await run("UPDATE social_deliveries SET status = 'cancelled', done_at = ? WHERE post_id = ? AND user_id = ? AND status = 'waiting'", [now(), postId, userId]);
  return done.rowsAffected;
}

/** The user's posts, the latest planned first, each with where it went or goes. */
export async function listPosts(userId: string): Promise<SocialPostView[]> {
  const posts = await all<{ id: string; text: string; title: string; link: string; file_id: string; file_name: string; due_at: number; created_at: number }>(
    "SELECT * FROM social_posts WHERE user_id = ? ORDER BY due_at DESC LIMIT 100",
    [userId],
  );
  if (!posts.length) return [];
  const deliveries = await all<{ post_id: string; account_id: string; network: NetworkId; status: SocialPostView["deliveries"][number]["status"]; url: string; problem: string; credits: number; name: string }>(
    `SELECT d.post_id, d.account_id, d.network, d.status, d.url, d.problem, d.credits, a.name FROM social_deliveries d JOIN social_accounts a ON a.id = d.account_id
     WHERE d.user_id = ? AND d.post_id IN (${posts.map(() => "?").join(",")})`,
    [userId, ...posts.map((p) => p.id)],
  );
  return posts.map((p) => ({
    id: p.id,
    text: p.text,
    title: p.title,
    link: p.link,
    fileId: p.file_id,
    fileName: p.file_name,
    at: Number(p.due_at),
    createdAt: Number(p.created_at),
    deliveries: deliveries
      .filter((d) => d.post_id === p.id)
      .map((d) => ({ accountId: d.account_id, network: d.network, name: d.name, status: d.status, url: d.url, problem: d.problem, credits: Number(d.credits) })),
  }));
}

// A delivery's lease: longer than the social tick may run (a YouTube upload takes minutes).
const LEASE_MS = 6 * 60_000;
const NO_CREDITS = msg("Not enough credits for this X post.");

type DeliveryRow = { id: string; post_id: string; user_id: string; account_id: string; network: NetworkId; status: string; due_at: number };

/**
 * Sends what is due (or one post's deliveries, right after it was made): each delivery claimed once,
 * then posted. Deliveries whose server stopped mid-way are closed first, as failed. The count sent.
 */
export async function sendDue({ postId = "", limit = 20 }: { postId?: string; limit?: number } = {}): Promise<number> {
  const time = now();
  await run("UPDATE social_deliveries SET status = 'failed', problem = ?, done_at = ? WHERE status = 'posting' AND lease_until < ?", [PROBLEMS.unknown, time, time]);
  const due = await all<DeliveryRow>(
    `SELECT * FROM social_deliveries WHERE status = 'waiting' AND due_at <= ?${postId ? " AND post_id = ?" : ""} ORDER BY due_at LIMIT ?`,
    postId ? [time, postId, limit] : [time, limit],
  );
  let sent = 0;
  for (const d of due) {
    const claimed = await run("UPDATE social_deliveries SET status = 'posting', lease_until = ? WHERE id = ? AND status = 'waiting'", [now() + LEASE_MS, d.id]);
    if (!claimed.rowsAffected) continue;
    await deliver(d);
    sent++;
  }
  return sent;
}

async function deliver(d: DeliveryRow): Promise<void> {
  const finish = (status: "done" | "failed", o: { remoteId?: string; url?: string; problem?: string; credits?: number } = {}) =>
    run("UPDATE social_deliveries SET status = ?, remote_id = ?, url = ?, problem = ?, credits = ?, done_at = ?, lease_until = 0 WHERE id = ? AND status = 'posting'", [
      status,
      o.remoteId ?? "",
      o.url ?? "",
      o.problem ?? "",
      o.credits ?? 0,
      now(),
      d.id,
    ]);
  const post = await one<{ text: string; title: string; link: string; file_id: string }>("SELECT * FROM social_posts WHERE id = ?", [d.post_id]);
  const account = await one<AccountRow>("SELECT * FROM social_accounts WHERE id = ? AND user_id = ?", [d.account_id, d.user_id]);
  if (!post || !account) return void (await finish("failed", { problem: NOT_FOUND }));
  let media: Media | null = null;
  if (post.file_id) {
    const file = await readFile(post.file_id, d.user_id);
    if (!file) return void (await finish("failed", { problem: msg("The picture or video was deleted from My creations.") }));
    media = { mime: file.mime, name: file.name, data: Buffer.from(file.data) };
  }
  let chargeId: number | null = null;
  let credits = 0;
  if (account.network === "x") {
    credits = xPostCredits(post.text);
    await ensureMonthlyCredits(d.user_id);
    chargeId = await charge(d.user_id, credits, "Social hub: X post");
    if (chargeId === null) return void (await finish("failed", { problem: NO_CREDITS }));
  }
  // Instagram and Threads fetch the file from Flash: a public address for this delivery only.
  let shared = "";
  try {
    let mediaUrl = "";
    if (media && (account.network === "instagram" || account.network === "threads")) {
      const origin = publicOrigin();
      if (!origin) throw new SocialError("bad_input", PROBLEMS.bad_input);
      shared = randomId(18);
      await run("INSERT INTO public_files (id, file_id, user_id, created_at) VALUES (?, ?, ?, ?)", [shared, post.file_id, d.user_id, now()]);
      mediaUrl = `${origin}/f/${shared}`;
    }
    const ctx = await contextFor(account);
    const posted = await publish(ctx, { text: post.text, title: post.title, link: post.link, media, mediaUrl, idempotencyKey: d.id });
    if (chargeId !== null) await settle(chargeId, credits);
    await finish("done", { remoteId: posted.remoteId.slice(0, 300), url: posted.url.slice(0, 500), credits });
    console.log(`[flash] social ${account.id} ${account.network} posted`);
  } catch (err) {
    const problem = err instanceof SocialError ? err : new SocialError("unknown", PROBLEMS.unknown);
    if (problem.code === "auth") await needsReconnect(account);
    // Given back unless X may have taken it (and billed Flash for it).
    if (chargeId !== null && problem.code !== "unknown") await settle(chargeId, 0);
    await finish("failed", { problem: problem.message, credits: chargeId !== null && problem.code === "unknown" ? credits : 0 });
    console.log(`[flash] social ${account.id} ${account.network} post failed: ${problem.code}`);
  } finally {
    if (shared) await run("DELETE FROM public_files WHERE id = ?", [shared]).catch(() => undefined);
  }
}

/** Flash's own public address, where Instagram and Threads fetch a post's file from. */
function publicOrigin(): string {
  const configured = env("FLASH_APP_URL").replace(/\/+$/, "");
  if (/^https:\/\/[\w.-]+(:\d+)?$/.test(configured)) return configured;
  // Tests and local trying only, with the networks' stand-ins.
  if (process.env.FLASH_CONNECT_MOCK && /^http:\/\/[\w.-]+(:\d+)?$/.test(configured)) return configured;
  const vercel = env("VERCEL_PROJECT_PRODUCTION_URL");
  return /^[\w.-]+$/.test(vercel) ? `https://${vercel}` : "";
}

/*
 * Meta's own requests (docs/social-setup.md): when a person removes Flash in their Facebook,
 * Instagram or Threads settings ("deauthorize"), or asks Meta to have their data deleted. Meta signs
 * each with the app's secret; the id it names is the person's id for that app.
 */
export type MetaRequest = "deauthorize" | "delete";

/** Applies a Meta request to the accounts it names: deauthorize marks them for Reconnect, delete removes them with their posts and inbox. The count. */
export async function metaRequest(kind: MetaRequest, networks: NetworkId[], metaUserId: string): Promise<number> {
  if (!/^\d{1,30}$/.test(metaUserId) || !networks.length) return 0;
  const marks = networks.map(() => "?").join(",");
  const rows = await all<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM social_accounts WHERE network IN (${marks}) AND (account_id = ? OR (network = 'instagram' AND server = ?))`,
    [...networks, metaUserId, metaUserId],
  );
  for (const row of rows) {
    if (kind === "deauthorize") {
      await run("UPDATE social_accounts SET status = 'needs_reconnect', refreshing_until = NULL WHERE id = ?", [row.id]);
      continue;
    }
    await (await db()).batch(
      [
        { sql: "DELETE FROM social_accounts WHERE id = ?", args: [row.id] },
        { sql: "DELETE FROM social_posts WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM social_deliveries d WHERE d.post_id = social_posts.id)", args: [row.user_id] },
      ],
      "write",
    );
  }
  console.log(`[flash] social meta ${kind}: ${rows.length} account(s)`);
  return rows.length;
}

// -------------------------------------------------------------------------------------- Inbox

// The inbox of networks that cost nothing to read is read this often; X's only when asked.
const INBOX_EVERY_MS = 15 * 60_000;
const INBOX_KEEP = 1000;

type InboxRow = { id: string; user_id: string; account_id: string; network: NetworkId; remote_id: string; kind: InboxItemView["kind"]; author: string; text: string; url: string; stars: number; ref: string; at: number; reply: string; replied_at: number; replying_until: number };

/** Reads one account's inbox and keeps what's new: how many items the network sent, and how many were new. */
async function syncAccount(row: AccountRow): Promise<{ read: number; added: number }> {
  const ctx = await contextFor(row);
  const { items, cursor } = await readInbox(ctx, row.inbox_cursor);
  const time = now();
  const statements = items.slice(0, 100).map((i) => ({
    sql: `INSERT INTO social_inbox (id, user_id, account_id, network, remote_id, kind, author, text, url, stars, ref, at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, remote_id) DO NOTHING`,
    args: [randomId(12), row.user_id, row.id, row.network, i.remoteId.slice(0, 300), i.kind, i.author.slice(0, 200), i.text, i.url.slice(0, 500), i.stars, JSON.stringify(i.ref), i.at, time],
  }));
  const results = await (await db()).batch(
    [
      ...statements,
      { sql: "UPDATE social_accounts SET inbox_cursor = ?, inbox_at = ? WHERE id = ?", args: [cursor.slice(0, 100), time, row.id] },
      {
        sql: "DELETE FROM social_inbox WHERE account_id = ? AND id NOT IN (SELECT id FROM social_inbox WHERE account_id = ? ORDER BY at DESC LIMIT ?)",
        args: [row.id, row.id, INBOX_KEEP],
      },
    ],
    "write",
  );
  return { read: items.length, added: results.slice(0, statements.length).reduce((n, r) => n + r.rowsAffected, 0) };
}

/** Reads the inboxes that are due (never X's, which costs money each time): for the social tick. */
export async function syncDueInboxes(limit = 10): Promise<number> {
  const time = now();
  const due = await all<AccountRow>("SELECT * FROM social_accounts WHERE status = 'ok' AND inbox_at < ? AND network NOT IN ('x', 'pinterest') ORDER BY inbox_at LIMIT ?", [time - INBOX_EVERY_MS, limit]);
  let read = 0;
  for (const row of due) {
    if (!isNetworkId(row.network) || !networkReady(row.network)) continue;
    // Taken once, whoever else ticks: the read time is moved first.
    const took = await run("UPDATE social_accounts SET inbox_at = ? WHERE id = ? AND inbox_at = ?", [time, row.id, row.inbox_at]);
    if (!took.rowsAffected) continue;
    try {
      read += (await syncAccount(row)).added;
    } catch (err) {
      if (err instanceof SocialError && err.code === "auth") await needsReconnect(row);
      console.log(`[flash] social ${row.id} ${row.network} inbox failed: ${err instanceof SocialError ? err.code : "error"}`);
    }
  }
  return read;
}

/**
 * Check for new messages now: every free inbox not read in the last minute, or one account's. X is
 * read only when its account is asked for by itself: the most it can cost is held first, and what
 * wasn't read given back. The number of new items.
 */
export async function refreshInbox(userId: string, accountId = ""): Promise<number> {
  if (await overLimit(`social-inbox:${userId}`, 30, HOUR)) throw new SocialInputError(msg("Too many checks in an hour. Try again later."), 429);
  const rows = accountId ? [await owned(userId, accountId)] : (await accountRows(userId)).filter((r) => r.network !== "x" && r.network !== "pinterest" && r.inbox_at < now() - 60_000);
  let added = 0;
  for (const row of rows) {
    if (row.status !== "ok" || !networkReady(row.network)) continue;
    let chargeId: number | null = null;
    const held = row.network === "x" ? xMentionsCredits() : 0;
    if (held) {
      await ensureMonthlyCredits(userId);
      chargeId = await charge(userId, held, "Social hub: X mentions");
      if (chargeId === null) throw new SocialInputError(msg("Checking X mentions uses up to {credits} credits, and you're out of credits."), 402, { credits: held });
    }
    try {
      const got = await syncAccount(row);
      added += got.added;
      // X bills each post it sends back, new to Flash or not: at most a page.
      if (chargeId !== null) await settle(chargeId, xReadCredits(got.read));
    } catch (err) {
      if (chargeId !== null) await settle(chargeId, err instanceof SocialError && err.code === "unknown" ? held : 0);
      if (err instanceof SocialError && err.code === "auth") await needsReconnect(row);
      if (accountId) throw new SocialInputError(err instanceof SocialError ? err.message : PROBLEMS.unreachable, 502);
    }
  }
  return added;
}

const refOf = (row: Pick<InboxRow, "ref">): Record<string, string> => {
  try {
    const ref: unknown = JSON.parse(row.ref);
    return ref && typeof ref === "object" && !Array.isArray(ref) ? Object.fromEntries(Object.entries(ref).filter(([, v]) => typeof v === "string")) : {};
  } catch {
    return {};
  }
};

export async function listInbox(userId: string): Promise<InboxItemView[]> {
  const rows = await all<InboxRow>("SELECT * FROM social_inbox WHERE user_id = ? ORDER BY at DESC LIMIT 200", [userId]);
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    network: r.network,
    kind: r.kind,
    author: r.author,
    text: r.text,
    url: r.url,
    stars: Number(r.stars),
    at: Number(r.at),
    repliedAt: Number(r.replied_at),
    reply: r.reply,
  }));
}

/** Answers an inbox item on its own network, once. X's reply is charged like a post. */
export async function replyToItem(userId: string, itemId: string, text: string): Promise<InboxItemView> {
  const words = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const item = /^[\w-]{8,40}$/.test(itemId) ? await one<InboxRow>("SELECT * FROM social_inbox WHERE id = ? AND user_id = ?", [itemId, userId]) : null;
  if (!item) throw new SocialInputError(msg("That message isn't there any more."), 404);
  if (item.replied_at) throw new SocialInputError(msg("You answered this one already."), 409);
  const network = networkById(item.network);
  if (!network) throw new SocialInputError(msg("Unknown network."));
  if (!words) throw new SocialInputError(msg("Write the answer first."));
  if (textLength(item.network, words) > Math.min(network.maxText, item.network === "youtube" || item.network === "google-business" ? 4000 : network.maxText)) {
    throw new SocialInputError(msg("This is too long for {network}: at most {max} characters."), 400, { network: network.name, max: network.maxText });
  }
  if (await overLimit(`social-reply:${userId}`, 60, HOUR)) throw new SocialInputError(msg("Too many answers in an hour. Try again later."), 429);
  const account = await owned(userId, item.account_id);
  const time = now();
  const took = await run("UPDATE social_inbox SET replying_until = ? WHERE id = ? AND replied_at = 0 AND replying_until < ?", [time + 2 * 60_000, item.id, time]);
  if (!took.rowsAffected) throw new SocialInputError(msg("This answer is being sent already."), 409);
  let chargeId: number | null = null;
  const credits = item.network === "x" ? xPostCredits(words) : 0;
  if (credits) {
    await ensureMonthlyCredits(userId);
    chargeId = await charge(userId, credits, "Social hub: X reply");
    if (chargeId === null) {
      await run("UPDATE social_inbox SET replying_until = 0 WHERE id = ?", [item.id]);
      throw new SocialInputError(NO_CREDITS, 402);
    }
  }
  try {
    await replyOn(await contextFor(account), refOf(item), words, item.id);
    if (chargeId !== null) await settle(chargeId, credits);
    await run("UPDATE social_inbox SET reply = ?, replied_at = ?, replying_until = 0 WHERE id = ?", [words, now(), item.id]);
    console.log(`[flash] social ${account.id} ${account.network} replied`);
    return (await listInbox(userId)).find((i) => i.id === item.id)!;
  } catch (err) {
    const problem = err instanceof SocialError ? err : new SocialError("unknown", PROBLEMS.unknown);
    if (chargeId !== null) await settle(chargeId, problem.code === "unknown" ? credits : 0);
    if (problem.code === "auth") await needsReconnect(account);
    // A reply the network may have taken stays locked for its two minutes, so a quick second press can't send it twice.
    if (problem.code !== "unknown") await run("UPDATE social_inbox SET replying_until = 0 WHERE id = ?", [item.id]);
    console.log(`[flash] social ${account.id} ${account.network} reply failed: ${problem.code}`);
    throw new SocialInputError(problem.message, 502);
  }
}

// ------------------------------------------------------------------------------------ The tick

/** Whether the social tick has anything to do (indexed reads only). */
export async function socialDue(): Promise<boolean> {
  const time = now();
  const checks = [
    { sql: "SELECT 1 FROM social_deliveries WHERE status = 'waiting' AND due_at <= ? LIMIT 1", args: [time] },
    { sql: "SELECT 1 FROM social_deliveries WHERE status = 'posting' AND lease_until < ? LIMIT 1", args: [time] },
    { sql: "SELECT 1 FROM social_accounts WHERE status = 'ok' AND inbox_at < ? AND network NOT IN ('x', 'pinterest') LIMIT 1", args: [time - INBOX_EVERY_MS] },
  ];
  for (const c of checks) if (await one(c.sql, c.args)) return true;
  return false;
}

/** One social tick: due posts first, then the inboxes that are due. */
export async function socialTick(): Promise<{ sent: number; read: number }> {
  if (!connectorsReady()) return { sent: 0, read: 0 };
  const sent = await sendDue({ limit: 25 });
  const read = await syncDueInboxes(10);
  return { sent, read };
}
