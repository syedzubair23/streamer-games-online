import type { Clock, TimerHandle } from "../src/config.ts";

/** A manual clock: timers fire only when {@link advance} passes their due time. */
export class FakeClock implements Clock {
  #now = 1_700_000_000_000;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as unknown as number);
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.#timers)
        if (e[1].at <= end && (!first || e[1].at < first[1].at)) first = e;
      if (!first) break;
      this.#timers.delete(first[0]);
      this.#now = Math.max(this.#now, first[1].at);
      first[1].fn();
    }
    this.#now = end;
  }

  /** Pending timers. */
  get pending(): number {
    return this.#timers.size;
  }
}
