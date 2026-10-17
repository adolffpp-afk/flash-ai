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
  // The people who signed up to a published app, with their own private records (see site-auth.ts).
  `CREATE TABLE IF NOT EXISTS site_users (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_users_email ON site_users(site_slug, email)`,
  // Members whose address has a character outside ASCII, which contacts may keep in another spelling:
  // a contact's page finds them without reading every member (see withAddress in contacts.ts).
  `CREATE INDEX IF NOT EXISTS site_users_unicode ON site_users(site_slug) WHERE email GLOB '*[^ -~]*'`,
  `CREATE TABLE IF NOT EXISTS site_sessions (
    token_hash TEXT PRIMARY KEY,
    site_user_id TEXT NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
    site_slug TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_sessions_user ON site_sessions(site_user_id)`,
  // Short-lived keys put into one page load, which an app's own requests carry.
  `CREATE TABLE IF NOT EXISTS site_page_tokens (
    token_hash TEXT PRIMARY KEY,
    site_user_id TEXT NOT NULL REFERENCES site_users(id) ON DELETE CASCADE,
    site_slug TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_page_tokens_expiry ON site_page_tokens(expires_at)`,
  // AI inside a published app (see site-ai.ts): off until its owner turns it on, with a daily
  // budget in credits and what it has used today.
  `CREATE TABLE IF NOT EXISTS site_ai (
    site_slug TEXT PRIMARY KEY REFERENCES sites(slug) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    daily_credits INTEGER NOT NULL DEFAULT 100,
    updated_at INTEGER NOT NULL
  )`,
  // Files people send to a published app (see site-files.ts).
  `CREATE TABLE IF NOT EXISTS site_uploads (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    owner TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_uploads_site ON site_uploads(site_slug, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_ai_usage (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    day TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_slug, day)
  )`,
  // Form messages sent to a site's owner through flashDB.send: private, unlike site_records.
  `CREATE TABLE IF NOT EXISTS site_messages (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    form TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS site_messages_site ON site_messages(site_slug, created_at)`,
  // One list per app of the people it heard from (forms, sign-ups, paid orders, or added by its
  // owner), one per email address (see contacts.ts). source is how it first heard from them; the
  // consent columns say what they agreed to get (by ticking a box themselves, or, after they
  // unsubscribed, by asking the owner, who recorded it: consent_by), with the wording, the form and
  // a keyed hash of their address, never the address itself.
  `CREATE TABLE IF NOT EXISTS site_contacts (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    phone TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    consent_text TEXT NOT NULL DEFAULT '',
    consent_at INTEGER NOT NULL DEFAULT 0,
    consent_ip TEXT NOT NULL DEFAULT '',
    consent_channel TEXT NOT NULL DEFAULT '',
    consent_form TEXT NOT NULL DEFAULT '',
    unsubscribed_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_contacts_email ON site_contacts(site_slug, email) WHERE email <> ''`,
  // Someone known only by their phone number is one contact too, kept apart from anyone with an
  // email address who gives that number (nobody proves a number is theirs).
  `CREATE UNIQUE INDEX IF NOT EXISTS site_contacts_phone_only ON site_contacts(site_slug, phone) WHERE email = '' AND phone <> ''`,
  `CREATE INDEX IF NOT EXISTS site_contacts_phone ON site_contacts(site_slug, phone) WHERE phone <> ''`,
  `CREATE INDEX IF NOT EXISTS site_contacts_seen ON site_contacts(site_slug, last_seen)`,
  `CREATE INDEX IF NOT EXISTS site_contacts_stage ON site_contacts(site_slug, stage, last_seen)`,
  // Who unsubscribed, so a box ticked for their mailbox under another address is found without
  // reading the whole list (see mailboxUnsubscribed in contacts.ts).
  `CREATE INDEX IF NOT EXISTS site_contacts_unsubscribed ON site_contacts(site_slug, email) WHERE unsubscribed_at > 0`,
  // How many contacts each app has, so a new one checks the 10,000 cap by reading one row instead of
  // counting the whole list. An app's row is made by counting once (see counted in contacts.ts), and
  // the two triggers keep it right from then on, whatever adds or deletes a contact. An app without
  // a row is counted again.
  `CREATE TABLE IF NOT EXISTS site_contact_counts (
    site_slug TEXT PRIMARY KEY REFERENCES sites(slug) ON DELETE CASCADE,
    n INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS site_contacts_added AFTER INSERT ON site_contacts BEGIN
    UPDATE site_contact_counts SET n = n + 1 WHERE site_slug = NEW.site_slug;
  END`,
  `CREATE TRIGGER IF NOT EXISTS site_contacts_removed AFTER DELETE ON site_contacts BEGIN
    UPDATE site_contact_counts SET n = n - 1 WHERE site_slug = OLD.site_slug;
  END`,
  // Custom domains that show a published site (see domains.ts and proxy.ts).
  `CREATE TABLE IF NOT EXISTS site_domains (
    domain TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_domains_site ON site_domains(site_slug)`,
  // Earlier versions of a published site, saved each time it's updated (see sites.ts).
  `CREATE TABLE IF NOT EXISTS site_versions (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    title TEXT NOT NULL,
    html TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_versions_site ON site_versions(site_slug, created_at)`,
  // Visits to published sites (see visits.ts): page loads per day and source, kept 100 days.
  `CREATE TABLE IF NOT EXISTS site_visits (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    day TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    views INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_slug, day, source)
  )`,
  // The people counted before site_people, with codes made without a key. Nothing writes it now:
  // the daily prune turns its days into totals (site_events' 'visit-old') and empties it.
  `CREATE TABLE IF NOT EXISTS site_visitors (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    day TEXT NOT NULL,
    visitor TEXT NOT NULL,
    PRIMARY KEY (site_slug, day, visitor)
  )`,
  // The tables below are WITHOUT ROWID: each row is kept once, in its primary key, where an ordinary
  // table also keeps the key in an automatic index, which Turso bills as another row written.
  //
  // Daily counts per app of people who took each step (see visits.ts and funnel.ts), never who they
  // were. step is one of:
  //   'visit', 'form', 'signup', 'checkout';
  //   'app:<name>': a step the app reported with flashDB.track;
  //   'visit-old': people counted before site_people, from site_visitors;
  //   'capped': the owner's daily people limit was reached and this app missed people that day;
  //   'capped-app': the owner's daily limit of app steps was reached;
  //   'capped-net': one network passed its number of new people that day, and later ones were views only.
  // source is '' for Direct and for every 'app:' step (those are counted without a source), '?' for
  // a form, sign-up or checkout that couldn't be matched to a visit that day or the day before, and
  // '(other)' past the day's limit of sources. n is people, each counted once a day per step; in '?'
  // rows it is sends, and in the marks it is the limit. Kept 100 days.
  `CREATE TABLE IF NOT EXISTS site_events (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    day TEXT NOT NULL,
    step TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    medium TEXT NOT NULL DEFAULT '',
    campaign TEXT NOT NULL DEFAULT '',
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_slug, day, step, source, medium, campaign)
  ) WITHOUT ROWID`,
  // Paid orders per day, source and currency (see funnel.ts): how many and what they took, never
  // which. Kept 100 days.
  `CREATE TABLE IF NOT EXISTS site_revenue (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    day TEXT NOT NULL,
    source TEXT NOT NULL,
    medium TEXT NOT NULL,
    campaign TEXT NOT NULL,
    currency TEXT NOT NULL,
    orders INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_slug, day, source, medium, campaign, currency)
  ) WITHOUT ROWID`,
  // Where an open checkout's buyer came from, until its order is saved or 3 days pass (see
  // funnel.ts). No buyer details. No site_slug index: it holds at most 3 days of checkouts, so
  // unpublishing reads it whole.
  `CREATE TABLE IF NOT EXISTS site_checkouts (
    session_id TEXT NOT NULL PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    source TEXT NOT NULL,
    medium TEXT NOT NULL,
    campaign TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  // The names an app reported with flashDB.track each day: at most 10 (see funnel.ts). Kept 2 days.
  `CREATE TABLE IF NOT EXISTS site_step_names (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (site_slug, day, name)
  ) WITHOUT ROWID`,
  // Each person's visit to an app on one day (see visits.ts). It keeps a code made with that day's
  // key (never their address), where they first came from that day, and the steps they were counted
  // for (a JSON list of at most 15). kind is 'visit', or 'owner' for the app's owner (signed in to
  // Flash on /p/, or with a working Open as owner code), who is never counted. Deleted after 2 days,
  // with the key.
  `CREATE TABLE IF NOT EXISTS site_people (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    day TEXT NOT NULL,
    visitor TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    medium TEXT NOT NULL DEFAULT '',
    campaign TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (site_slug, day, visitor)
  ) WITHOUT ROWID`,
  // How many people, and how many app steps, were counted each day across all of one owner's apps
  // (see visits.ts and funnel.ts), for their plan's daily limits. Deleted after 2 days.
  `CREATE TABLE IF NOT EXISTS owner_people (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    people INTEGER NOT NULL DEFAULT 0,
    steps INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  ) WITHOUT ROWID`,
  // The random key that makes each day's visitor codes (see visits.ts). Deleted after 2 days, with
  // the codes it made, so no code can be traced back to an address after that.
  `CREATE TABLE IF NOT EXISTS visit_keys (day TEXT PRIMARY KEY, secret TEXT NOT NULL) WITHOUT ROWID`,
  // Selling from published sites (see shop.ts): each seller's own Stripe account, the items a
  // site sells with their prices, and the orders paid.
  `CREATE TABLE IF NOT EXISTS seller_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_account TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '',
    ready INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_products (
    id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    price INTEGER NOT NULL,
    currency TEXT NOT NULL,
    delivery INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (site_slug, name)
  )`,
  `CREATE TABLE IF NOT EXISTS site_orders (
    session_id TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    item TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_orders_site ON site_orders(site_slug, created_at)`,
  // The same for orders whose address has a character outside ASCII.
  `CREATE INDEX IF NOT EXISTS site_orders_unicode ON site_orders(site_slug) WHERE email GLOB '*[^ -~]*'`,
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
  // Money that went back to a buyer: a refund (each partial refund adds a row) or a dispute.
  // total_cents is how much of the charge has gone back so far; amount_cents what this row added.
  `CREATE TABLE IF NOT EXISTS payment_reversals (
    ref TEXT PRIMARY KEY,
    charge TEXT NOT NULL,
    kind TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    test INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS payment_reversals_time ON payment_reversals(created_at)`,
  // Bills the owner pays every month or year (hosting, database, domain), typed in on the dashboard.
  `CREATE TABLE IF NOT EXISTS admin_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    per TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
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
  // Auto top-up: buys a credit pack with the saved card when the balance falls below a level (see auto-topup.ts).
  `CREATE TABLE IF NOT EXISTS auto_topups (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    pack TEXT NOT NULL,
    below INTEGER NOT NULL,
    customer TEXT,
    payment_method TEXT,
    last_at INTEGER NOT NULL DEFAULT 0,
    failed TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
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
  // MET Norway forecasts, shared by every user in the same ~1 km cell. MET's terms: don't ask again
  // before Expires, and revalidate with If-Modified-Since (see server/weather.ts).
  `CREATE TABLE IF NOT EXISTS weather_cache (
    cell TEXT PRIMARY KEY,
    series TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_modified TEXT NOT NULL DEFAULT '',
    fetched_at INTEGER NOT NULL
  )`,
  // Lets the prune read only the old rows: Turso bills rows read.
  `CREATE INDEX IF NOT EXISTS weather_cache_fetched ON weather_cache(fetched_at)`,
  // Answers from web search, SEC EDGAR and FRED, kept a short while and shared by every user, so the
  // same question doesn't ask again (see server/source-fetch.ts). value is what Flash kept, already trimmed.
  `CREATE TABLE IF NOT EXISTS source_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS source_cache_expires ON source_cache(expires_at)`,
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
  // Keys that let a published app's owner change its shared data from the app itself (see
  // site-owner.ts). Each is made from a one-time code below and ends with the owner's Flash sign-in,
  // or after an hour.
  `CREATE TABLE IF NOT EXISTS site_owner_keys (
    token_hash TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_owner_keys_expiry ON site_owner_keys(expires_at)`,
  `CREATE INDEX IF NOT EXISTS site_owner_keys_site ON site_owner_keys(site_slug, user_id)`,
  // One-time codes that open an app as its owner, made when they choose Open as owner in Flash.
  // Each works once, for two minutes, and becomes an owner key when the app's page is served at
  // the address it was made for: host is the app's own domain, or "" for Flash's own address.
  `CREATE TABLE IF NOT EXISTS site_owner_codes (
    code_hash TEXT PRIMARY KEY,
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    host TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS site_owner_codes_site ON site_owner_codes(site_slug)`,
  // Who may change each collection of an app's shared data, as its owner chose in Flash (see
  // data-rules.ts). collection "*" is the owner's rule for every collection without its own.
  `CREATE TABLE IF NOT EXISTS site_collection_rules (
    site_slug TEXT NOT NULL REFERENCES sites(slug) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    rule TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (site_slug, collection)
  )`,
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
  // Referral bonuses, one per referred friend, given on the friend's first real payment of a plan
  // that counts (REFERRAL_EARNS in credits.ts; credit packs never do). The friend's bonus is credited at once; the referrer's waits until referrer_available_at and is
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
  // The Flash connector: apps like Claude or ChatGPT that a user lets use Flash (see connector.ts).
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS oauth_tokens_user ON oauth_tokens(user_id, client_id)`,
  // Links to files a connected app made, which the app can show or download without signing in.
  `CREATE TABLE IF NOT EXISTS public_files (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  )`,
  // One brand kit per user (see brand.ts). The logo is a file, shared through a public link.
  `CREATE TABLE IF NOT EXISTS brand_kits (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    tagline TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    colors TEXT NOT NULL DEFAULT '[]',
    logo_file TEXT NOT NULL DEFAULT '',
    logo_link TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  // Stop pressed on a chat reply, by the reply's id. The request answering it may be running on
  // another server instance, so it looks here every second or two (see stops.ts).
  `CREATE TABLE IF NOT EXISTS chat_stops (
    user_id TEXT NOT NULL,
    reply_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, reply_id)
  )`,
  // Old Stops are cleared by time on every Stop (see stops.ts).
  `CREATE INDEX IF NOT EXISTS chat_stops_time ON chat_stops(created_at)`,
  // Connectors: the user's own accounts that replies can use (see connections.ts). The secret is
  // sealed (secret-box.ts) and only its last 4 characters are kept to show. A server the user added
  // keeps only its origin in url: its whole address, which may hold a secret too, is sealed in
  // enc_url. protocol is the MCP
  // version the server answered with. Turso runs with foreign keys off, so a connection's rows are
  // deleted by hand (see removeConnection); the references are there to say what belongs to what.
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    enc_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ok',
    enc_secret TEXT NOT NULL DEFAULT '',
    key_version TEXT NOT NULL DEFAULT '',
    last4 TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id)`,
  // Each connection's tools as the user saw them when they added it, pinned by a hash of the name,
  // description and schema; a tool whose hash changes is left out (changed) until they look again.
  `CREATE TABLE IF NOT EXISTS connection_tools (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    schema TEXT NOT NULL DEFAULT '{}',
    hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trusted INTEGER NOT NULL DEFAULT 0,
    changed INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (connection_id, name)
  )`,
  // A tool call waiting for the user to approve it (see pending-actions.ts): single use, bound to its
  // user and to a hash of its input, and gone 24 hours after it finished.
  `CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    tool_hash TEXT NOT NULL,
    input_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    reply_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT NOT NULL DEFAULT '',
    result_error INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS pending_actions_user ON pending_actions(user_id, created_at)`,
  // The Google Drive files a user picked for Flash with Google's Picker (see google.ts): the only
  // files a reply can read or add rows to. Their name and type are what Google said when they were
  // picked, never what the browser sent. Deleted by hand with their connection (see removeConnection).
  `CREATE TABLE IF NOT EXISTS connection_files (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    picked_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, file_id)
  )`,
  // A sign-in to a connector's server under way (see mcp-oauth.ts): kept here, never in a cookie,
  // because the callback acts on what it says. Found by a hash of its state, taken once by its own
  // user with one conditional DELETE, and gone after 10 minutes. The PKCE verifier and the server's
  // address (which may hold a key) are sealed.
  `CREATE TABLE IF NOT EXISTS connect_flows (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enc_verifier TEXT NOT NULL,
    provider TEXT NOT NULL,
    connection_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    enc_url TEXT NOT NULL DEFAULT '',
    issuer TEXT NOT NULL,
    resource TEXT NOT NULL,
    client_reg_id TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '',
    redirect_uri TEXT NOT NULL,
    endpoints_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS connect_flows_expiry ON connect_flows(expires_at)`,
  // Who Flash is to each authorization server, kept by its issuer (so re-registering never orphans
  // earlier sign-ins). Flash's own registrations (a Client ID Metadata Document, or one made by
  // Dynamic Client Registration) are shared by every user (owner_user_id NULL), one per issuer and
  // callback address. A client ID and secret a user typed in for a server with neither belong to
  // that user alone (owner_user_id), and are never used for anyone else.
  `CREATE TABLE IF NOT EXISTS mcp_client_registrations (
    id TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    client_id TEXT NOT NULL,
    enc_client_secret TEXT NOT NULL DEFAULT '',
    enc_registration_token TEXT NOT NULL DEFAULT '',
    auth_method TEXT NOT NULL DEFAULT 'none',
    method TEXT NOT NULL,
    key_version TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (issuer, owner_user_id)
  )`,
  // SQLite counts NULLs as different in a UNIQUE constraint, so the shared rows need their own index.
  `CREATE UNIQUE INDEX IF NOT EXISTS mcp_client_registrations_shared ON mcp_client_registrations(issuer, redirect_uri) WHERE owner_user_id IS NULL`,
  // Two-step sign-in with an authenticator app (see two-factor.ts): the app's secret, sealed, and
  // whether it's on (enabled_at 0 while being set up); last_step is the newest code used, so no
  // code works twice. Recovery codes are kept only as hashes, and each works once.
  `CREATE TABLE IF NOT EXISTS two_factor (
    user_id TEXT PRIMARY KEY,
    enc_secret TEXT NOT NULL,
    enabled_at INTEGER NOT NULL DEFAULT 0,
    last_step INTEGER NOT NULL DEFAULT -1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS two_factor_recovery (
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    PRIMARY KEY (user_id, code_hash)
  )`,
  // A sign-in that got past the password (or link, or Google) and now waits for the code.
  `CREATE TABLE IF NOT EXISTS two_factor_pending (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    next TEXT NOT NULL DEFAULT '/',
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  )`,
  // Uploaded files the virus scanner passed, by content hash, so a file sent again isn't scanned
  // again for a while (see virus-scan.ts).
  `CREATE TABLE IF NOT EXISTS scanned_clean (
    hash TEXT PRIMARY KEY,
    scanned_at INTEGER NOT NULL
  )`,
  // Reports of what people share or publish, for Flash's admins only (see reports.ts). While an
  // item's report is open, the same network reporting it again for the same reason adds to repeats
  // instead of a new row. reporter is a hash of the network's address, never the address itself.
  // owner_id is whose item it was, and title what it was called, when it was reported.
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    via TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    reporter TEXT NOT NULL,
    repeats INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reports_open ON reports(item_kind, item_id, reporter, reason) WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS reports_time ON reports(created_at)`,
  // What an admin did about an item's reports (marked them reviewed, took the item down), by whom and when.
  `CREATE TABLE IF NOT EXISTS report_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    action TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS report_actions_item ON report_actions(item_kind, item_id)`,
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
  // Pinned projects stay at the top of the sidebar.
  "ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
  // What Flash should keep in mind for every answer in one project.
  "ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
  // When the site's owner marked an order as handled (sent, picked up), or 0.
  "ALTER TABLE site_orders ADD COLUMN done_at INTEGER NOT NULL DEFAULT 0",
  // Settings > General: what Flash should call the user, and what best describes their work.
  "ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN work TEXT NOT NULL DEFAULT ''",
  // The language Flash answers in (see languages.ts); empty means the language the user writes in.
  "ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT ''",
  // Whose record this is, when an app keeps private data for each person signed in to it.
  // Empty means the record is shared by everyone using the app, as before.
  "ALTER TABLE site_records ADD COLUMN owner TEXT NOT NULL DEFAULT ''",
  // The sign-in a page key was made from, so signing out ends both. Empty for keys made before.
  "ALTER TABLE site_page_tokens ADD COLUMN session_hash TEXT NOT NULL DEFAULT ''",
  // Whether people using a published app may send it files. Off until its owner turns it on.
  "ALTER TABLE sites ADD COLUMN uploads_on INTEGER NOT NULL DEFAULT 0",
  // The data rules Flash read from the app's page (see data-rules.ts). Empty until worked out.
  "ALTER TABLE sites ADD COLUMN data_rules TEXT NOT NULL DEFAULT ''",
  // The signed-in person who added a shared record, so they alone can change it. Empty for anyone else.
  "ALTER TABLE site_records ADD COLUMN author TEXT NOT NULL DEFAULT ''",
  // The address an Open as owner code works at (see site_owner_codes), for tables made before it.
  "ALTER TABLE site_owner_codes ADD COLUMN host TEXT NOT NULL DEFAULT ''",
  // When a held charge was settled to what the request really cost, or 0 while it runs.
  "ALTER TABLE credit_ledger ADD COLUMN settled_at INTEGER NOT NULL DEFAULT 0",
  // People added to a team plan on top of its own seats, each with more monthly credits (EXTRA_SEAT).
  "ALTER TABLE subscriptions ADD COLUMN extra_seats INTEGER NOT NULL DEFAULT 0",
  // Counts every write of a project's messages, so the server saving a reply never overwrites
  // a change saved since it read them (see turns.ts).
  "ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
  // 1 for a row that only carries what another provider cost in the same request (a helper),
  // so request counts skip it. Its credits are 0; the request's main row (0) has them.
  "ALTER TABLE usage ADD COLUMN part INTEGER NOT NULL DEFAULT 0",
  // Connections signed in with OAuth (see mcp-oauth.ts): the sealed access and refresh tokens, when
  // the access token runs out, the authorization server (issuer), the resource the tokens are for,
  // Flash's registration there, the scopes it asks for, the server's token and revocation endpoints,
  // and refreshing_until, which lets one refresh run at a time per connection.
  "ALTER TABLE connections ADD COLUMN enc_access TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE connections ADD COLUMN enc_refresh TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE connections ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE connections ADD COLUMN issuer TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE connections ADD COLUMN resource TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE connections ADD COLUMN client_reg_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE connections ADD COLUMN scopes TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE connections ADD COLUMN endpoints_json TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE connections ADD COLUMN refreshing_until INTEGER",
  // The account the tokens are for, so a sign-in as another account is told apart: for GitHub, the
  // GitHub account's number (its login is shown in the connection's label, see keepGithub); for Google
  // Drive, the Google account's sub (see keepGoogle).
  "ALTER TABLE connections ADD COLUMN account_id TEXT NOT NULL DEFAULT ''",
  // Whether the app's link preview says "Made with Flash ∞ AI" (see made-with.ts). On until its owner,
  // on a paid plan, turns it off.
  "ALTER TABLE sites ADD COLUMN made_with INTEGER NOT NULL DEFAULT 1",
  // The stages of the app's contact list, as JSON [{id, name}]; '' is New, Contacted, Won, Lost.
  "ALTER TABLE sites ADD COLUMN contact_stages TEXT NOT NULL DEFAULT ''",
  // The app's own key for its unsubscribe links and its contacts' hashed addresses, made on first use.
  "ALTER TABLE sites ADD COLUMN contact_secret TEXT NOT NULL DEFAULT ''",
  // 1 once the members, orders and messages the app had before contacts existed were copied in, and 2
  // once an unsubscribe #114 took also reached the same mailbox's other contacts (see fillContacts).
  "ALTER TABLE sites ADD COLUMN contacts_filled INTEGER NOT NULL DEFAULT 0",
  // Whose message it is (see contacts.ts); '' when the form had no email or phone number.
  "ALTER TABLE site_messages ADD COLUMN contact_id TEXT NOT NULL DEFAULT ''",
  // Who recorded that a contact agreed to news: '' for a box they ticked on a form, 'owner' for the
  // owner recording that they asked for news again after unsubscribing (see recordConsent).
  "ALTER TABLE site_contacts ADD COLUMN consent_by TEXT NOT NULL DEFAULT ''",
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
  await c.execute("CREATE INDEX IF NOT EXISTS site_records_owner ON site_records(site_slug, owner, collection, created_at)");
  await c.execute("CREATE INDEX IF NOT EXISTS site_messages_contact ON site_messages(site_slug, contact_id)");
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
