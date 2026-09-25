/**
 * Reactions (SPEC §4): the 6 fixed emotes are counted and flushed as one `reactions` message
 * every {@link REACTION_INTERVAL_MS}. Nothing is sent for a window with no reactions, so an
 * idle room costs nothing. The Stage caps the floating sprites (30) on its side.
 *
 * @module
 */
import { isReactionId, type ReactionId } from "@sg/shared";
import type { Clock, TimerHandle } from "../config.ts";

/** Reactions are aggregated and sent every 500 ms (SPEC §4). */
export const REACTION_INTERVAL_MS = 500;

/** Counts reactions and emits them in 500 ms batches. */
export class ReactionAggregator {
  readonly #clock: Clock;
  readonly #emit: (counts: Partial<Record<ReactionId, number>>) => void;
  readonly #intervalMs: number;
  #counts: Partial<Record<ReactionId, number>> = {};
  #pending = 0;
  #timer: TimerHandle | null = null;

  constructor(
    clock: Clock,
    emit: (counts: Partial<Record<ReactionId, number>>) => void,
    intervalMs = REACTION_INTERVAL_MS,
  ) {
    this.#clock = clock;
    this.#emit = emit;
    this.#intervalMs = intervalMs;
  }

  /** Counts one reaction; unknown ids are dropped. Returns whether it was counted. */
  add(e: unknown): boolean {
    if (!isReactionId(e)) return false;
    this.#counts[e] = (this.#counts[e] ?? 0) + 1;
    this.#pending++;
    // A batch opens with its first reaction and goes out one interval later, so batches are
    // never closer together than the interval and a quiet room sends nothing.
    if (this.#timer === null)
      this.#timer = this.#clock.setTimeout(() => this.#flush(), this.#intervalMs);
    return true;
  }

  /** Reactions counted but not yet sent. */
  get pending(): number {
    return this.#pending;
  }

  /** Stops the flush timer and drops anything pending. */
  dispose(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#counts = {};
    this.#pending = 0;
  }

  #flush(): void {
    this.#timer = null;
    if (this.#pending === 0) return;
    const counts = this.#counts;
    this.#counts = {};
    this.#pending = 0;
    this.#emit(counts);
  }
}
