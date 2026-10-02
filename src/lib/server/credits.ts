import { CREDIT_PACKS, FREE_MONTHLY_CREDITS } from "../credits.ts";
import { all, one, run, now } from "./db.ts";

export async function balance(userId: string): Promise<number> {
  const row = await one<{ total: number }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ?",
    [userId],
  );
  return Number(row?.total ?? 0);
}

const monthKey = (t = new Date()) => `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;

/** Tops the free allowance back up once per calendar month (never takes credits away). */
export async function ensureMonthlyCredits(userId: string): Promise<void> {
  const ref = `free:${userId}:${monthKey()}`;
  if (await one("SELECT 1 FROM credit_ledger WHERE ref = ?", [ref])) return;
  const topUp = Math.max(0, FREE_MONTHLY_CREDITS - (await balance(userId)));
  await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, topUp, "Monthly free credits", ref, now()],
  );
}

/**
 * Takes credits only if the balance covers them. Returns the ledger entry's id, or null when
 * the balance is too low. Pass the id to settle() to lower the charge once the real cost is known.
 */
export async function charge(userId: string, amount: number, reason: string): Promise<number | null> {
  if (amount <= 0) return 0;
  const r = await run(
    `INSERT INTO credit_ledger (user_id, amount, reason, created_at)
     SELECT ?, ?, ?, ?
     WHERE (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id = ?) >= ?`,
    [userId, -amount, reason, now(), userId, amount],
  );
  return r.rowsAffected === 1 ? Number(r.lastInsertRowid) : null;
}

/** Lowers a held charge to what the request really used (never raises it). */
export async function settle(chargeId: number, used: number): Promise<void> {
  if (!chargeId) return;
  await run("UPDATE credit_ledger SET amount = MAX(amount, ?) WHERE id = ?", [-Math.max(0, used), chargeId]);
}

/** Logs one request for the owner dashboard. */
export async function logUsage(entry: {
  userId: string;
  engine: string;
  model: string;
  provider: string;
  credits: number;
  costCents: number;
  ok: boolean;
}): Promise<void> {
  await run(
    "INSERT INTO usage (user_id, engine, model, provider, credits, cost_cents, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [entry.userId, entry.engine, entry.model, entry.provider, entry.credits, entry.costCents, entry.ok ? 1 : 0, now()],
  );
}

export async function refund(userId: string, amount: number, reason: string): Promise<void> {
  if (amount <= 0) return;
  await run("INSERT INTO credit_ledger (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)", [
    userId,
    amount,
    reason,
    now(),
  ]);
}

/** Adds a purchased pack once per payment reference (webhooks can be delivered twice). */
export async function addPurchase(userId: string, packId: string, ref: string): Promise<boolean> {
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) return false;
  const r = await run(
    "INSERT OR IGNORE INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, pack.credits, `Bought ${pack.name} pack`, ref, now()],
  );
  if (r.rowsAffected !== 1) return false;
  await run(
    "INSERT OR IGNORE INTO purchases (user_id, pack, credits, amount_cents, test, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [userId, pack.id, pack.credits, pack.priceCents, ref.startsWith("stripe:") ? 0 : 1, ref, now()],
  );
  return true;
}

export async function recentActivity(userId: string, limit = 20) {
  return all<{ amount: number; reason: string; created_at: number }>(
    "SELECT amount, reason, created_at FROM credit_ledger WHERE user_id = ? AND amount != 0 ORDER BY id DESC LIMIT ?",
    [userId, limit],
  );
}
