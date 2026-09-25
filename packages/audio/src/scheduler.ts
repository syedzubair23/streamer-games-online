/**
 * A look-ahead scheduler ("A Tale of Two Clocks"): a coarse timer wakes every `intervalMs` and
 * asks the caller to schedule everything due in the next `aheadS` seconds of **context time**,
 * so timing is sample-accurate even when the main thread stutters. While the context is
 * suspended its clock stands still, so nothing piles up; if the clock ever runs past the
 * scheduled horizon (a long stall) the missed window is skipped, never replayed in a burst.
 *
 * @module
 */

/** Timer functions (injectable for tests). */
export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

/** Options of {@link createScheduler}. */
export interface SchedulerOptions {
  intervalMs?: number;
  aheadS?: number;
  timers?: Timers;
}

/** A running look-ahead scheduler. */
export interface Scheduler {
  /** Stops waking up (already scheduled audio still plays). */
  stop(): void;
  /** Context time up to which events have been handed out. */
  readonly horizon: number;
}

const defaultTimers: Timers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>),
};

/**
 * Starts calling `fill(from, to)` for consecutive, non-overlapping windows of context time.
 * The first window starts at `ctx.currentTime`.
 */
export function createScheduler(
  ctx: Pick<BaseAudioContext, "currentTime">,
  fill: (from: number, to: number) => void,
  o: SchedulerOptions = {},
): Scheduler {
  const timers = o.timers ?? defaultTimers;
  const ahead = o.aheadS ?? 0.15;
  let horizon = ctx.currentTime;
  const tick = (): void => {
    const now = ctx.currentTime;
    if (horizon < now) horizon = now;
    const to = now + ahead;
    if (to <= horizon) return;
    const from = horizon;
    horizon = to;
    fill(from, to);
  };
  const id = timers.setInterval(tick, o.intervalMs ?? 25);
  tick();
  return {
    stop: () => timers.clearInterval(id),
    get horizon() {
      return horizon;
    },
  };
}
