import { db, now, one, run } from "./db.ts";
import { randomId, sha256 } from "./ids.ts";
import { canonicalJson } from "./mcp-client.ts";
import type { ActionCard, ToolKind } from "../connectors.ts";

/*
 * Connector calls waiting for the user (S-3 in the connectors plan). A write, or any call Flash won't
 * run by itself, is stored here and shown as a card; nothing runs until the user approves it on
 * Flash's own page. An approval is single use, only for its own user, only for the exact input it was
 * shown with, and only for 30 minutes. Approving runs the call with no model, so it costs no credits
 * and writes nothing to the credit ledger. Finished rows are deleted 24 hours later, whenever a new
 * one is written (Flash has no scheduled jobs).
 */

export const ACTION_TTL_MS = 30 * 60_000;
const KEEP_FINISHED_MS = 24 * 60 * 60_000;

export type ActionRow = {
  id: string;
  user_id: string;
  connection_id: string;
  tool: string;
  tool_hash: string;
  input_json: string;
  input_hash: string;
  reply_id: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  result: string;
  result_error: number;
  used: number;
  created_at: number;
  expires_at: number;
  finished_at: number;
};

/** The hash an approval is bound to: of the input exactly as it will be sent, whatever its key order. */
export const inputHash = (input: unknown) => sha256(canonicalJson(input));

/** Stores a call to wait for the user and returns its card. */
export async function proposeAction(a: {
  userId: string;
  connectionId: string;
  connection: string;
  host: string;
  tool: string;
  title: string;
  toolHash: string;
  kind: ToolKind;
  custom: boolean;
  input: Record<string, unknown>;
  // What Flash knows input values as (a picked file's name for its id): shown on the card, never stored or sent.
  labels?: Record<string, string>;
  replyId?: string;
  at?: number;
}): Promise<ActionCard> {
  const at = a.at ?? now();
  const id = randomId(16);
  const hash = inputHash(a.input);
  const expiresAt = at + ACTION_TTL_MS;
  await (await db()).batch(
    [
      // Old rows go whenever a new one is written.
      { sql: "DELETE FROM pending_actions WHERE (status != 'pending' AND status != 'running' AND finished_at < ?) OR expires_at < ?", args: [at - KEEP_FINISHED_MS, at - KEEP_FINISHED_MS] },
      {
        sql: `INSERT INTO pending_actions (id, user_id, connection_id, tool, tool_hash, input_json, input_hash, reply_id, status, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        args: [id, a.userId, a.connectionId, a.tool, a.toolHash, JSON.stringify(a.input), hash, a.replyId ?? "", at, expiresAt],
      },
    ],
    "write",
  );
  return {
    id,
    connectionId: a.connectionId,
    connection: a.connection,
    host: a.host,
    tool: a.tool,
    title: a.title,
    input: a.input,
    ...(a.labels && Object.keys(a.labels).length && { labels: a.labels }),
    inputHash: hash,
    kind: a.kind,
    custom: a.custom,
    expiresAt,
    status: "pending",
  };
}

/**
 * Takes an approval: one conditional write, so of two clicks (or two tabs, or a replay) only one
 * runs. Only the action's own user, with the input hash the card showed, before it expires.
 * Returns the row, now running, or null.
 */
export async function claimAction(userId: string, id: string, hash: string, at = now()): Promise<ActionRow | null> {
  const r = await run(
    "UPDATE pending_actions SET status = 'running' WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ? AND input_hash = ?",
    [id, userId, at, hash],
  );
  if (r.rowsAffected !== 1) return null;
  return one<ActionRow>("SELECT * FROM pending_actions WHERE id = ? AND user_id = ?", [id, userId]);
}

/** Records how an approved action ended, with what it returned (cut, without secrets; see runApproved). */
export async function finishAction(id: string, ok: boolean, result: string, at = now()): Promise<void> {
  await run("UPDATE pending_actions SET status = ?, result = ?, result_error = ?, finished_at = ? WHERE id = ? AND status = 'running'", [
    ok ? "done" : "failed",
    result,
    ok ? 0 : 1,
    at,
    id,
  ]);
}

/** Cancels a waiting action of the user's. Costs nothing. */
export async function cancelAction(userId: string, id: string, at = now()): Promise<boolean> {
  const r = await run("UPDATE pending_actions SET status = 'cancelled', finished_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'", [at, id, userId]);
  return r.rowsAffected === 1;
}

/** An action of the user's as its card shows it now, or null. */
export async function actionStatus(userId: string, id: string, at = now()): Promise<{ status: NonNullable<ActionCard["status"]>; result?: string } | null> {
  const row = await one<ActionRow>("SELECT * FROM pending_actions WHERE id = ? AND user_id = ?", [id, userId]);
  if (!row) return null;
  if (row.status === "pending" && row.expires_at <= at) return { status: "expired" };
  if (row.status === "running") return { status: "pending" };
  return { status: row.status, ...(row.result && { result: row.result }) };
}

/**
 * Approved results the user asked to continue the answer with (the card's Continue): only their own,
 * done, not yet used and recent. peek leaves them as they are (for pricing); take marks each used
 * once, when the reply runs.
 */
export async function approvedResults(userId: string, ids: string[], { take = false, at = now() } = {}): Promise<ActionRow[]> {
  const out: ActionRow[] = [];
  for (const id of [...new Set(ids)].slice(0, 4)) {
    const row = await one<ActionRow>(
      "SELECT * FROM pending_actions WHERE id = ? AND user_id = ? AND status = 'done' AND used = 0 AND finished_at > ?",
      [id, userId, at - ACTION_TTL_MS],
    );
    if (!row) continue;
    if (take) {
      const r = await run("UPDATE pending_actions SET used = 1 WHERE id = ? AND user_id = ? AND used = 0", [id, userId]);
      if (r.rowsAffected !== 1) continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Puts approved results back for another Continue, when the reply that took them failed or was
 * stopped: Retry sends them again (see continueWith in Flash.tsx), and is paid like any reply.
 */
export async function releaseResults(userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await run(`UPDATE pending_actions SET used = 0 WHERE user_id = ? AND used = 1 AND id IN (${ids.map(() => "?").join(",")})`, [userId, ...ids]);
}

/**
 * Whether an approval comes from Flash's own page: JSON, with an Origin header that is exactly one of
 * Flash's own origins (its configured address, or the one the request came to). A missing Origin,
 * "null" (a sandboxed page, like a published app on Flash's host) or any other origin is refused, and
 * so is a request the browser says is cross-site.
 */
export function approvalAllowed(request: Request, ownOrigins: string[]): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  return Boolean(origin) && origin !== "null" && ownOrigins.includes(origin!);
}
