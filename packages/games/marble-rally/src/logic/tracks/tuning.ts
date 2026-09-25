/**
 * The race-side constants the shipped tracks are tuned against (docs/specs/marble-rally.md R5,
 * R6). The race rules (M9-01) must use these values: the track checks simulate 200 races per
 * track with exactly this behaviour, so changing one means re-running
 * `node --import tsx test/track-lab.ts check` and re-tuning the tracks.
 *
 * All values are in solver units (ticks at 60 Hz; velocities in fixed units per tick) or in
 * progress units (0–10000 along the centreline).
 *
 * @module
 */

/** R6: the stuck window, in ticks (4 s). */
export const STUCK_TICKS = 240;
/** R6: a marble whose progress rises by less than this over {@link STUCK_TICKS} is kicked. */
export const STUCK_MIN_RISE = 16;
/**
 * R6: ticks without progress before a DNF (12 s). "Progress" means the marble's best progress
 * rising by at least {@link STUCK_MIN_RISE}, so a marble creeping forward by a few units at a
 * time still runs out its clock.
 */
export const DNF_TICKS = 720;
/**
 * R6 kick: a one-tick horizontal velocity add of `±(KICK_MIN + rng.int(KICK_SPREAD))` from
 * `rng.fork("kick:" + id)`, sign first (`rng.bool()`), then size. 48–80 fixed units per tick
 * (3–5 world units per tick) restarts a stopped marble at race pace: on the tracks' shallow
 * coasting runs gravity cannot restart it (see the Builder notes), so a weaker kick leaves it
 * crawling.
 */
export const KICK_MIN = 48;
/** See {@link KICK_MIN}: the kick size is `KICK_MIN + rng.int(KICK_SPREAD)` (48–80). */
export const KICK_SPREAD = 33;
/** R5 nudge: `(±NUDGE_X, +NUDGE_Y)` per tick for {@link NUDGE_TICKS} ticks. */
export const NUDGE_X = 24;
/** R5 nudge, vertical part. */
export const NUDGE_Y = 8;
/** R5 nudge duration in ticks. */
export const NUDGE_TICKS = 6;
