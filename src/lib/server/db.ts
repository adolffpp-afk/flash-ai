import { createClient, type Client, type InValue } from "@libsql/client";

// Local development uses a SQLite file. In production set DATABASE_URL (and DATABASE_AUTH_TOKEN)
// to a hosted libSQL database such as Turso, because serverless hosts don't keep local files.
const url = process.env.DATABASE_URL || "file:flash.db";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    preferences TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_free_grant INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_ref ON credit_ledger(ref) WHERE ref IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger(user_id)`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sites (
    slug TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    html TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_records (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    credits INTEGER NOT NULL,
    cost_cents REAL NOT NULL,
    ok INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS usage_time ON usage(created_at)`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    pack TEXT NOT NULL,
    credits INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    test INTEGER NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
  // Monthly plans. paid_until is how far the subscriber has paid; credits arrive once a month
  // from anchor (the subscription's start) for as long as that month began before paid_until.
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    interval TEXT NOT NULL,
    status TEXT NOT NULL,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    customer TEXT,
    amount_cents INTEGER NOT NULL,
    anchor INTEGER NOT NULL,
    paid_until INTEGER NOT NULL,
    test INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id, paid_until)`,
  // Free-lane use per provider per UTC day, kept under each provider's free limit.
  `CREATE TABLE IF NOT EXISTS free_quota (
    day TEXT NOT NULL,
    provider TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    neurons REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider)
  )`,
  `CREATE INDEX IF NOT EXISTS usage_user_time ON usage(user_id, created_at)`,
  // One-time links for email verification and password reset (only hashes are stored).
  `CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Attempt counters for sign-in, sign-up and emails, shared by every server instance.
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS site_records_lookup ON site_records(site_slug, collection, created_at)`,
  // Free-lane requests per user per UTC day, reserved before each request so parallel ones can't pass the cap.
  `CREATE TABLE IF NOT EXISTS free_user_quota (
    day TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, user_id, kind)
  )`,
  // Google, GitHub and Microsoft accounts linked to a Flash account. subject is the provider's id for the person.
  `CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  )`,
  `CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id)`,
  // Emailed sign-in links (15 minutes, one use). Keyed by email so they work before an account exists.
  `CREATE TABLE IF NOT EXISTS sign_in_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    next TEXT NOT NULL DEFAULT '/',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Referral bonuses, one per referred friend, given on the friend's first real payment. The
  // friend's bonus is credited at once; the referrer's waits until referrer_available_at and is
  // cancelled (cancelled_at) if that payment is refunded or disputed before then.
  `CREATE TABLE IF NOT EXISTS referral_rewards (
    friend_id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    purchase_ref TEXT NOT NULL,
    friend_credits INTEGER NOT NULL,
    referrer_credits INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    referrer_available_at INTEGER NOT NULL DEFAULT 0,
    cancelled_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS referral_rewards_referrer ON referral_rewards(referrer_id)`,
  `CREATE INDEX IF NOT EXISTS referral_rewards_purchase ON referral_rewards(purchase_ref)`,
  // Business plan teams. The owner's credit balance is the team's shared pool while the owner
  // has a paid-up team plan. A user belongs to at most one team.
  `CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_members (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS team_members_team ON team_members(team_id)`,
  // Email invitations to a team (only the link's hash is stored).
  `CREATE TABLE IF NOT EXISTS team_invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    email_key TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS team_invites_team ON team_invites(team_id)`,
  // Read-only links to a chat as it was when shared. messages is a cleaned copy (see shares.ts).
  `CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    messages TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id, project_id)`,
];

let client: Client | null = null;
let ready: Promise<void> | null = null;

// Columns added after launch; ALTER fails harmlessly when the column already exists.
const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0",
  // The email with Gmail-style dots and +tags removed, so one inbox can't farm free credits.
  "ALTER TABLE users ADD COLUMN email_key TEXT NOT NULL DEFAULT ''",
  // What a purchase was paid with, so a refund or dispute of that payment can take its credits back.
  "ALTER TABLE purchases ADD COLUMN payment_intent TEXT",
  "ALTER TABLE purchases ADD COLUMN subscription TEXT",
  // Each user's referral code, and the user who referred them (set once, at sign-up).
  "ALTER TABLE users ADD COLUMN ref_code TEXT",
  "ALTER TABLE users ADD COLUMN referred_by TEXT",
  // The referrer's bonus waits 30 days (see referrals.ts).
  "ALTER TABLE referral_rewards ADD COLUMN referrer_available_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE referral_rewards ADD COLUMN cancelled_at INTEGER NOT NULL DEFAULT 0",
  // Who spent a charge, when a team member spends the owner's shared pool.
  "ALTER TABLE credit_ledger ADD COLUMN actor TEXT",
];

async function init(c: Client) {
  await c.execute("PRAGMA foreign_keys = ON");
  await c.batch(SCHEMA, "write");
  for (const sql of MIGRATIONS) await c.execute(sql).catch(() => {});
  await c.execute("CREATE INDEX IF NOT EXISTS users_email_key ON users(email_key)");
  await c.execute("CREATE INDEX IF NOT EXISTS purchases_payment_intent ON purchases(payment_intent)");
  await c.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code ON users(ref_code) WHERE ref_code IS NOT NULL");
  await c.execute("CREATE INDEX IF NOT EXISTS users_referred_by ON users(referred_by)");
  await c.execute("CREATE INDEX IF NOT EXISTS credit_ledger_actor ON credit_ledger(actor)");
}

/** Returns the database client, creating the tables on first use. */
export async function db(): Promise<Client> {
  if (!client) {
    client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
    ready = init(client);
  }
  await ready;
  return client;
}

export async function one<T>(sql: string, args: InValue[] = []): Promise<T | null> {
  const r = await (await db()).execute({ sql, args });
  return (r.rows[0] as unknown as T) ?? null;
}

export async function all<T>(sql: string, args: InValue[] = []): Promise<T[]> {
  const r = await (await db()).execute({ sql, args });
  return r.rows as unknown as T[];
}

export async function run(sql: string, args: InValue[] = []) {
  return (await db()).execute({ sql, args });
}

export const now = () => Date.now();
