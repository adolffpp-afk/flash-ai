import type { StreamEvent } from "../types.ts";

/**
 * How a request reads its engine's events (see the chat route): each is sent as it comes, until the
 * engine ends ("ended") or the request is told to stop ("stopped"). Stop is checked before each step
 * and heard at once through wake, without waiting for the engine's next event. With drainMs, an
 * engine told to stop is read on for up to that long: a Claude engine, whose call is cut by the same
 * Stop, then ends at once, and hands over what it finished before (an app, sources, the end of a
 * reply already paid for). One that comes to its end that way is "ended": nothing was cut. Throws
 * whatever the engine throws.
 */
export async function readEngine(
  steps: AsyncIterator<StreamEvent>,
  send: (e: StreamEvent) => void,
  control: { halted: () => boolean; onWake: (wake: () => void) => void; drainMs?: number },
): Promise<"ended" | "stopped"> {
  let drainUntil = 0;
  for (;;) {
    const next = steps.next();
    let step = control.halted()
      ? "stop"
      : await new Promise<Awaited<typeof next> | "stop">((resolve, reject) => {
          control.onWake(() => resolve("stop"));
          next.then(resolve, reject);
        });
    if (step === "stop" && control.drainMs !== undefined) {
      drainUntil ||= Date.now() + control.drainMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"stop">((resolve) => (timer = setTimeout(() => resolve("stop"), Math.max(0, drainUntil - Date.now()))));
      step = await Promise.race([next, late]).finally(() => clearTimeout(timer));
    }
    if (step === "stop") {
      next.catch(() => {});
      steps.return?.(undefined).catch(() => {});
      return "stopped";
    }
    if (step.done) return "ended";
    send(step.value);
  }
}
