/*
 * Checks files people upload for viruses before Flash uses or stores them, with Flash's own ClamAV
 * scanner (the scanner/ folder, deployed on Railway; steps in docs/virus-scan-setup.md). Off until
 * VIRUS_SCAN_URL and VIRUS_SCAN_KEY are set. When they are but the scanner can't be reached, files
 * go through and the outage is logged, so a scanner problem never stops people working.
 */
import { createHash } from "node:crypto";
import { all, run, now } from "./db.ts";

const TIMEOUT_MS = 20_000;
// A clean file isn't scanned again for a week (chat sends earlier files with every message);
// after that it's checked again against newer virus definitions.
const CLEAN_FOR_MS = 7 * 86_400_000;

export type ScanFile = { name: string; bytes: Buffer };

const scannerUrl = () => process.env.VIRUS_SCAN_URL?.trim().replace(/\/+$/, "") ?? "";
const scannerKey = () => process.env.VIRUS_SCAN_KEY?.trim() ?? "";

/** Whether Flash scans uploads: both scanner variables are set. */
export const scannerSetUp = () => Boolean(scannerUrl() && scannerKey());

/** The names of the scanner variables that aren't set, for the owner dashboard (never their values). */
export const scannerMissing = () =>
  [["VIRUS_SCAN_URL", scannerUrl()], ["VIRUS_SCAN_KEY", scannerKey()]].filter(([, v]) => !v).map(([k]) => k);

/** What the scanner says about one file: clean, infected, or null when it couldn't say. */
async function scanOne(bytes: Buffer): Promise<{ clean: boolean; virus?: string } | null> {
  try {
    const res = await fetch(`${scannerUrl()}/scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${scannerKey()}`, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`scanner answered ${res.status}`);
    const body = (await res.json()) as { clean?: unknown; virus?: unknown };
    if (typeof body.clean !== "boolean") throw new Error("scanner gave no verdict");
    return { clean: body.clean, virus: typeof body.virus === "string" ? body.virus : undefined };
  } catch (err) {
    console.error("[flash] virus scanner unavailable, file let through", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The name of the first file the scanner finds a virus in, or null when all are clean (or
 * scanning is off or unavailable).
 */
export async function infectedFile(files: ScanFile[]): Promise<string | null> {
  if (!scannerSetUp() || !files.length) return null;
  const hashed = files.map((f) => ({ ...f, hash: createHash("sha256").update(f.bytes).digest("hex") }));
  const hashes = [...new Set(hashed.map((f) => f.hash))];
  const known = new Set(
    (
      await all<{ hash: string }>(
        `SELECT hash FROM scanned_clean WHERE scanned_at > ? AND hash IN (${hashes.map(() => "?").join(", ")})`,
        [now() - CLEAN_FOR_MS, ...hashes],
      )
    ).map((r) => r.hash),
  );
  const fresh = hashed.filter((f, i) => !known.has(f.hash) && hashed.findIndex((g) => g.hash === f.hash) === i);
  const verdicts = await Promise.all(fresh.map((f) => scanOne(f.bytes)));
  const clean = fresh.filter((_, i) => verdicts[i]?.clean === true);
  for (const f of clean) {
    await run("INSERT INTO scanned_clean (hash, scanned_at) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET scanned_at = excluded.scanned_at", [f.hash, now()]);
  }
  if (clean.length && Math.random() < 0.02) await run("DELETE FROM scanned_clean WHERE scanned_at < ?", [now() - CLEAN_FOR_MS]);
  const bad = fresh.findIndex((_, i) => verdicts[i]?.clean === false);
  if (bad < 0) return null;
  console.warn(`[flash] virus refused: ${verdicts[bad]?.virus ?? "unknown"}`);
  return fresh[bad].name;
}

/** Whether the scanner answers and ClamAV is ready, for the owner dashboard; null when it isn't set up. */
export async function scannerReady(): Promise<boolean | null> {
  if (!scannerSetUp()) return null;
  try {
    const res = await fetch(`${scannerUrl()}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
