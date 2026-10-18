/*
 * A second (or third) Flash server for the race and kill tests (see automation-race.test.ts): a child
 * process with its own database client on the same file, so two workers really race through SQLite's
 * locks instead of taking turns on one connection. The parent sends commands over IPC and gets each
 * answer back; with a probe armed, the worker tells the parent when it reaches that point and waits
 * there until told to go on (or is killed there).
 *
 *   { id, cmd: "claim", args: [worker, limits] }           claimRuns
 *   { id, cmd: "start", args: [runId, me, options] }       startStep
 *   { id, cmd: "charge", args: [list of chargeOnce options] } every chargeOnce at once
 *   { id, cmd: "arm", args: [point] }                      wait at this probe point
 *   { cmd: "go" }                                          go on from the probe point
 */
export {};
const send = (message: unknown) => process.send!(message);

const { db } = await import("../../src/lib/server/db.ts");
await db();
const leases = await import("../../src/lib/server/leases.ts");
const credits = await import("../../src/lib/server/credits.ts");

const armed = new Set<string>();
let go: (() => void) | null = null;
leases.probes.at = async (point, info) => {
  if (!armed.has(point)) return;
  armed.delete(point);
  send({ at: point, info });
  await new Promise<void>((resolve) => (go = resolve));
};

process.on("message", async (m: { id?: number; cmd: string; args?: unknown[] }) => {
  if (m.cmd === "go") {
    const resume = go;
    go = null;
    resume?.();
    return;
  }
  const args = (m.args ?? []) as never[];
  try {
    let value: unknown;
    if (m.cmd === "claim") value = await leases.claimRuns(args[0], args[1]);
    else if (m.cmd === "start") value = await leases.startStep(args[0], args[1], args[2]);
    else if (m.cmd === "charge") value = await Promise.all((args[0] as unknown as Parameters<typeof credits.chargeOnce>[0][]).map((o) => credits.chargeOnce(o)));
    else if (m.cmd === "arm") value = armed.add(args[0]) && true;
    else throw new Error(`unknown command ${m.cmd}`);
    send({ id: m.id, ok: true, value: value ?? null });
  } catch (err) {
    send({ id: m.id, ok: false, error: String((err as Error)?.stack ?? err) });
  }
});

send({ ready: true });
