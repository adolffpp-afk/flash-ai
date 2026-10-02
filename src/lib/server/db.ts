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
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS site_records_lookup ON site_records(site_slug, collection, created_at)`,
];

let client: Client | null = null;
let ready: Promise<void> | null = null;

async function init(c: Client) {
  await c.execute("PRAGMA foreign_keys = ON");
  await c.batch(SCHEMA, "write");
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
