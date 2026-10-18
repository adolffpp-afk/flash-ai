/*
 * Accounts, automations and runs for the automation tests, written straight into the database the
 * test set up (DATABASE_URL is set before this file is imported).
 */
import { createHash, randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { one, run as sql } from "../../src/lib/server/db.ts";
import { runnerFor, type Spec } from "../../src/lib/automations.ts";

const monthOf = (t = new Date()) => `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;

/** A signed-in account with credits (their free credits for this month already given, so none are added). */
export async function account(id: string, credits: number, o: { verified?: boolean; email?: string } = {}) {
  const token = `tok_${id}_${randomBytes(6).toString("hex")}`;
  await sql("INSERT INTO users (id, email, name, password_hash, preferences, created_at, last_free_grant, verified_at) VALUES (?, ?, '', 'x', '', 0, 0, ?)", [
    id,
    o.email ?? `${id}@example.com`,
    o.verified === false ? 0 : 1,
  ]);
  await sql("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600_000]);
  await sql("INSERT INTO credit_ledger (user_id, amount, reason, ref, created_at) VALUES (?, ?, 'test', ?, 0)", [id, credits, `free:${id}:${monthOf()}`]);
  return { id, cookie: `flash_session=${token}` };
}

export const balance = async (id: string) => Number((await one<{ b: number }>("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE user_id = ?", [id]))!.b);

/** One AI step that writes, then a notice: the smallest personal automation. */
export const WRITE_SPEC: Spec = {
  v: 1,
  trigger: { type: "manual" },
  steps: [
    { id: "a1", do: "ai", mode: "write", level: "sonic", prompt: "Write one line about the weather." },
    { id: "n1", do: "notify" },
  ],
};

let made = 0;
/** An automation with its first version. */
export async function automation(o: {
  userId: string;
  id?: string;
  spec?: Spec;
  status?: string;
  capRun?: number;
  capMonth?: number;
  nextAt?: number;
  timeZone?: string;
  name?: string;
  runner?: number;
  pausedReason?: string;
  resumeAt?: number;
}) {
  const id = o.id ?? `auto${++made}${randomBytes(3).toString("hex")}`;
  const spec = o.spec ?? WRITE_SPEC;
  const t = Date.now();
  await sql(
    `INSERT INTO automations (id, user_id, pay_account, name, status, paused_reason, resume_at, version, trigger_kind, time_zone, next_at, cap_run, cap_month, quoted_max, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      o.userId,
      o.userId,
      o.name ?? "Morning note",
      o.status ?? "on",
      o.pausedReason ?? "",
      o.resumeAt ?? 0,
      spec.trigger.type,
      o.timeZone ?? "UTC",
      o.nextAt ?? 0,
      o.capRun ?? 100,
      o.capMonth ?? 1000,
      o.capRun ?? 100,
      t,
      t,
    ],
  );
  await sql("INSERT INTO automation_versions (automation_id, version, user_id, spec, runner, created_at) VALUES (?, 1, ?, ?, ?, ?)", [
    id,
    o.userId,
    JSON.stringify(spec),
    o.runner ?? runnerFor(spec),
    t,
  ]);
  return id;
}

/** A run waiting to be claimed (due a second ago unless told otherwise). */
export async function runRow(o: {
  automationId: string;
  userId: string;
  id?: string;
  status?: string;
  dueAt?: number;
  graceUntil?: number;
  runKey?: string;
  step?: string;
  nextPaid?: number;
  parked?: number;
  attempts?: number;
  origin?: string;
}) {
  const id = o.id ?? `run${++made}${randomBytes(3).toString("hex")}`;
  const t = Date.now();
  await sql(
    `INSERT INTO automation_runs (id, automation_id, user_id, version, run_key, origin, root_origin, status, step, next_paid, parked, attempts, due_at, grace_until, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      o.automationId,
      o.userId,
      o.runKey ?? `manual:${id}`,
      o.origin ?? "owner",
      o.origin ?? "owner",
      o.status ?? "queued",
      o.step ?? "",
      o.nextPaid ?? 1,
      o.parked ?? 0,
      o.attempts ?? 0,
      o.dueAt ?? t - 1000,
      o.graceUntil ?? 0,
      o.dueAt ?? t - 1000,
      t,
      t,
    ],
  );
  return id;
}

export type Worker = {
  child: ChildProcess;
  call: <T = unknown>(cmd: string, ...args: unknown[]) => Promise<T>;
  // Resolves when the worker reaches an armed probe point (it waits there until go(), or is killed).
  reached: (point: string) => Promise<Record<string, unknown> | undefined>;
  go: () => void;
  kill: () => Promise<void>;
};

/** A worker process with its own client on the database file (see support/automation-worker.ts). */
export async function startWorker(dbFile: string, env: Record<string, string> = {}): Promise<Worker> {
  const child = fork(new URL("./automation-worker.ts", import.meta.url).pathname, [], {
    execArgv: ["--experimental-strip-types", "--no-warnings"],
    env: { ...process.env, ...env, DATABASE_URL: `file:${dbFile}` },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const atPoint = new Map<string, (info: Record<string, unknown> | undefined) => void>();
  const seenAt = new Map<string, Record<string, unknown> | undefined>();
  let ready: () => void;
  const isReady = new Promise<void>((resolve) => (ready = resolve));
  child.on("message", (m: { id?: number; ok?: boolean; value?: unknown; error?: string; at?: string; info?: Record<string, unknown>; ready?: boolean }) => {
    if (m.ready) return ready();
    if (m.at) {
      const wake = atPoint.get(m.at);
      if (wake) wake(m.info);
      else seenAt.set(m.at, m.info);
      return;
    }
    const w = waiting.get(m.id!);
    waiting.delete(m.id!);
    if (m.ok) w?.resolve(m.value);
    else w?.reject(new Error(m.error));
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  child.on("exit", () => {
    for (const w of waiting.values()) w.reject(new Error("worker exited"));
    waiting.clear();
  });
  await isReady;
  let n = 0;
  return {
    child,
    call: <T,>(cmd: string, ...args: unknown[]) =>
      new Promise<T>((resolve, reject) => {
        const id = ++n;
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
        child.send({ id, cmd, args });
      }),
    reached: (point) =>
      seenAt.has(point) ? Promise.resolve(seenAt.get(point)) : new Promise((resolve) => atPoint.set(point, resolve)),
    go: () => child.send({ cmd: "go" }),
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}
