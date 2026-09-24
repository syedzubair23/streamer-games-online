/**
 * `ctx.timing` (SPEC §9.3 `Timing`, §4 "Stream delay", §15 "Timers"): the only way game logic
 * turns a base duration into a deadline length.
 *
 * - `input(base)` is a **player or audience input window**: `base × timerScale + streamDelay`,
 *   or `null` when `timerScale = 0` (no input timers; the host advances with `forceAdvance`).
 * - `pace(base)` is **pacing** (reveals, animations, readouts): `base`, never scaled, never null.
 *
 * Games store the resulting absolute deadline (`ctx.now + timing.input(…)`) in their state, so
 * views always carry the real deadline and the runner never rescales timers behind their back.
 *
 * @module
 */
import { ROOM_LIMITS, type RoomConfig } from "@sg/shared";
import type { Timing } from "./game-module.ts";

/** The room settings that shape timing (a subset of {@link RoomConfig}). */
export type TimingConfig = Pick<RoomConfig, "timerScale" | "streamDelaySec">;

/** Every legal `RoomConfig.timerScale` (SPEC §7). */
export const TIMER_SCALES: readonly RoomConfig["timerScale"][] = Object.freeze([
  0, 0.75, 1, 1.5, 2,
]);

/**
 * The minimum audience window (SPEC §4): an early close of a timed audience poll is held until
 * at least `streamDelaySec + 5 s` after the poll opened. This is the fixed 5 s part.
 */
export const MIN_AUDIENCE_WINDOW_EXTRA_MS = 5_000;

/**
 * Builds the {@link Timing} a runner hands to game logic.
 *
 * @throws RangeError when `timerScale` is not one of {@link TIMER_SCALES} or `streamDelaySec`
 *   is outside `0..8` (SPEC §7), so a bad room config fails loudly instead of skewing timers.
 */
export function createTiming(config: TimingConfig): Timing {
  const { timerScale, streamDelaySec } = config;
  if (!TIMER_SCALES.includes(timerScale)) {
    throw new RangeError(`createTiming: timerScale must be one of ${TIMER_SCALES.join(", ")}`);
  }
  const { min, max } = ROOM_LIMITS.streamDelaySec;
  if (!Number.isFinite(streamDelaySec) || streamDelaySec < min || streamDelaySec > max) {
    throw new RangeError(`createTiming: streamDelaySec must be in ${min}..${max}`);
  }
  const delayMs = Math.round(streamDelaySec * 1000);
  const timing: Timing = {
    input(baseMs: number): number | null {
      assertDuration(baseMs, "input");
      if (timerScale === 0) return null;
      return Math.round(baseMs * timerScale) + delayMs;
    },
    pace(baseMs: number): number {
      assertDuration(baseMs, "pace");
      return baseMs;
    },
  };
  return Object.freeze(timing);
}

/**
 * The minimum audience window in ms for a stream delay (SPEC §4):
 * `streamDelaySec × 1000 + 5000`.
 */
export function minAudienceWindowMs(streamDelaySec: number): number {
  return Math.round(streamDelaySec * 1000) + MIN_AUDIENCE_WINDOW_EXTRA_MS;
}

function assertDuration(ms: number, which: string): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`timing.${which}: base must be a finite, non-negative ms value`);
  }
}
