import { readFileSync } from "node:fs";

/**
 * A variable as it was in this process's environment when it started (/proc/self/environ), which is
 * what glibc reads its malloc settings from: a value set later in code (process.env) isn't there.
 * null when it wasn't set, undefined when that can't be told (not Linux).
 */
export function startEnv(name: string): string | null | undefined {
  try {
    const entry = readFileSync("/proc/self/environ", "utf8")
      .split("\0")
      .find((e) => e.startsWith(`${name}=`));
    return entry === undefined ? null : entry.slice(name.length + 1);
  } catch {
    return undefined;
  }
}
