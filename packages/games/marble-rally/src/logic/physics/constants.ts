/**
 * Marble Rally solver constants (docs/specs/marble-rally.md "Physics").
 *
 * Every value is an integer in solver units:
 * - lengths and positions in **fixed units** of 1/16 world unit ({@link FP});
 * - velocities in fixed units per tick, accelerations in fixed units per tick²;
 * - unit normals scaled by {@link NORM_ONE} (1/4096).
 *
 * @module
 */

/** Fixed-point sub-units per world unit: positions are `int32` in 1/16 unit. */
export const FP = 16;
/** Scale of precomputed unit normals (1/4096). */
export const NORM_ONE = 4096;
/** log2 of {@link NORM_ONE}. */
export const NORM_SHIFT = 12;

/** World width in world units. */
export const WORLD_W_UNITS = 4096;
/** World height in world units. */
export const WORLD_H_UNITS = 8192;
/** World width in fixed units (65,536). */
export const WORLD_W = WORLD_W_UNITS * FP;
/** World height in fixed units (131,072). */
export const WORLD_H = WORLD_H_UNITS * FP;

/** Marble radius in world units. */
export const MARBLE_RADIUS_UNITS = 44;
/** Marble radius in fixed units (704). */
export const MARBLE_R = MARBLE_RADIUS_UNITS * FP;

/** Simulation steps per second. */
export const TICK_HZ = 60;
/** Substeps per step. */
export const SUBSTEPS = 2;

/** Default gravity along y, fixed units per tick² (−3). */
export const GRAVITY = -3;
/** Speed cap, fixed units per tick. */
export const SPEED_CAP = 96;

/** Wall restitution numerator (5/8). */
export const WALL_E_NUM = 5;
/** Wall restitution denominator. */
export const WALL_E_DEN = 8;
/** Marble–marble restitution numerator (3/4). */
export const PAIR_E_NUM = 3;
/** Marble–marble restitution denominator. */
export const PAIR_E_DEN = 4;
/** Tangential friction on wall impacts: `v_t -= v_t / 16`. */
export const FRICTION_DIV = 16;
/**
 * Resting-contact threshold (fixed units per tick): contacts approaching slower than this are
 * perfectly inelastic along the normal and frictionless along the tangent (rolling), so marbles
 * settle and roll instead of jittering or sliding to a stop. Twice the gravity step.
 */
export const REST_VN = 6;

/** Broadphase cell size in world units. */
export const CELL_UNITS = 128;
/** Broadphase cell size in fixed units (2,048). */
export const CELL = CELL_UNITS * FP;
/** log2 of {@link CELL}. */
export const CELL_SHIFT = 11;
/** Broadphase grid columns (32). */
export const GRID_COLS = WORLD_W / CELL;
/** Broadphase grid rows (64). */
export const GRID_ROWS = WORLD_H / CELL;

/** Server hard cap on marbles (SPEC: host cap 50–1000). Pair keys and buffers are sized to it. */
export const MAX_MARBLES = 1000;
