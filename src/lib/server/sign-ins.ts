/*
 * The sign-in log for the owner dashboard (/admin, Sign-ins tab): who signed in, when, how, and
 * from which country. Nothing else about the person or their device is kept: no IP address, no
 * browser. Rows older than KEEP_DAYS go.
 */
import { all, one, run, now } from "./db.ts";
import { countryOf } from "./free.ts";

export const SIGN_IN_METHODS = ["password", "email_link", "google", "github", "microsoft", "reset", "sign_up"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
export const isSignInMethod = (m: unknown): m is SignInMethod => SIGN_IN_METHODS.includes(m as SignInMethod);

const DAY = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 400;
export const LOG_PAGE = 50;

/**
 * Notes a finished sign-in (after two-step sign-in's code, when that is on). Never fails the sign-in:
 * a log row that can't be written is only logged.
 */
export async function recordSignIn(userId: string, method: SignInMethod, request: Request): Promise<void> {
  try {
    const country = countryOf(request);
    await run("INSERT INTO sign_ins (user_id, method, country, created_at) VALUES (?, ?, ?, ?)", [
      userId,
      method,
      /^[A-Z]{2}$/.test(country) ? country : "",
      now(),
    ]);
    // Old rows go now and then, here.
    if (Math.random() < 0.02) await run("DELETE FROM sign_ins WHERE created_at < ?", [now() - KEEP_DAYS * DAY]);
  } catch (err) {
    console.error("[flash] sign-in log failed", err);
  }
}

export type SignInRow = { id: number; at: number; email: string; name: string; method: string; country: string };

/**
 * The newest sign-ins first, LOG_PAGE at a time: q matches the account's email or name, before is
 * the id of the last row already shown (for "Show more").
 */
export async function signInLog(q = "", before = 0): Promise<{ rows: SignInRow[]; more: boolean }> {
  const like = `%${q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await all<{ id: number; created_at: number; email: string; name: string; method: string; country: string }>(
    `SELECT s.id, s.created_at, COALESCE(u.email, '') AS email, COALESCE(u.name, '') AS name, s.method, s.country
     FROM sign_ins s LEFT JOIN users u ON u.id = s.user_id
     WHERE (? = 0 OR s.id < ?) AND (? = '%%' OR LOWER(u.email) LIKE ? ESCAPE '\\' OR LOWER(u.name) LIKE ? ESCAPE '\\')
     ORDER BY s.id DESC LIMIT ?`,
    [before, before, like, like, like, LOG_PAGE + 1],
  );
  return {
    rows: rows.slice(0, LOG_PAGE).map((r) => ({
      id: Number(r.id),
      at: Number(r.created_at),
      email: r.email,
      name: r.name,
      method: r.method,
      country: r.country,
    })),
    more: rows.length > LOG_PAGE,
  };
}

/**
 * How many different accounts signed in, used Flash (sent a request) and were made: today (since
 * midnight UTC), in the last 7 days and in the last 30, and each day of the last 30.
 */
export async function signInCounts() {
  const n = (v: unknown) => Number(v ?? 0);
  const today = Math.floor(now() / DAY) * DAY;
  const periods = { today, week: today - 6 * DAY, month: today - 29 * DAY };
  const count = async (sql: string, since: number) => n((await one<{ c: number }>(sql, [since]))?.c);
  const signedIn = "SELECT COUNT(DISTINCT user_id) AS c FROM sign_ins WHERE created_at >= ?";
  const active = "SELECT COUNT(DISTINCT user_id) AS c FROM usage WHERE created_at >= ?";
  const created = "SELECT COUNT(*) AS c FROM users WHERE created_at >= ?";
  const of = async (sql: string) => ({
    today: await count(sql, periods.today),
    week: await count(sql, periods.week),
    month: await count(sql, periods.month),
  });

  const byDay = (sql: string) => all<{ day: number; c: number }>(sql, [DAY, periods.month]);
  const [daySignIns, dayActive, dayNew] = [
    await byDay("SELECT CAST(created_at / ? AS INTEGER) AS day, COUNT(DISTINCT user_id) AS c FROM sign_ins WHERE created_at >= ? GROUP BY day"),
    await byDay("SELECT CAST(created_at / ? AS INTEGER) AS day, COUNT(DISTINCT user_id) AS c FROM usage WHERE created_at >= ? GROUP BY day"),
    await byDay("SELECT CAST(created_at / ? AS INTEGER) AS day, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY day"),
  ];
  const on = (rows: { day: number; c: number }[], d: number) => n(rows.find((r) => n(r.day) === d)?.c);
  const series = [];
  for (let d = periods.month / DAY; d <= today / DAY; d++) {
    series.push({ day: d * DAY, signedIn: on(daySignIns, d), active: on(dayActive, d), new: on(dayNew, d) });
  }
  const first = await one<{ at: number | null }>("SELECT MIN(created_at) AS at FROM sign_ins");

  return {
    // Every account there is.
    users: await count("SELECT COUNT(*) AS c FROM users WHERE created_at >= ?", 0),
    signedIn: await of(signedIn),
    active: await of(active),
    new: await of(created),
    series,
    // When the log starts (null while it's empty): sign-ins before it weren't noted.
    since: first?.at == null ? null : n(first.at),
  };
}
