/**
 * Marble bodies: struct-of-arrays `int32` state, plus exact JSON round-tripping for
 * `MrState.sim` (docs/specs/marble-rally.md "Types": flat, JSON-safe arrays).
 *
 * @module
 */
import { MAX_MARBLES } from "./constants.ts";

/**
 * Every marble's physics state. Marble `i` is index `i` in each array; ids are dense and
 * collision pairs resolve in ascending id order.
 */
export interface Bodies {
  /** Number of marbles in use (`0 ≤ count ≤ capacity`). */
  count: number;
  /** Centre x, fixed units. */
  x: Int32Array;
  /** Centre y, fixed units (gravity pulls toward −y). */
  y: Int32Array;
  /** Velocity x, fixed units per tick. */
  vx: Int32Array;
  /** Velocity y, fixed units per tick. */
  vy: Int32Array;
  /** 1 while simulated; 0 for finished, eliminated or DNF marbles (not moved, not collided). */
  alive: Uint8Array;
  /**
   * One-tick velocity adds (nudges, shake, kicks), consumed and cleared by the next step.
   * Fixed units per tick.
   */
  ix: Int32Array;
  /** See {@link Bodies.ix}. */
  iy: Int32Array;
}

/** The JSON form of {@link Bodies} (the solver part of `MrState.sim`). */
export interface BodiesJson {
  x: number[];
  y: number[];
  vx: number[];
  vy: number[];
  alive: number[];
  ix: number[];
  iy: number[];
}

/**
 * Allocates bodies for up to `capacity` marbles, all at the origin, at rest and not alive.
 * @throws RangeError unless `0 ≤ capacity ≤ 1000` (the server hard cap).
 */
export function createBodies(capacity: number): Bodies {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_MARBLES)
    throw new RangeError(`capacity must be an integer in [0, ${MAX_MARBLES}]`);
  return {
    count: 0,
    x: new Int32Array(capacity),
    y: new Int32Array(capacity),
    vx: new Int32Array(capacity),
    vy: new Int32Array(capacity),
    alive: new Uint8Array(capacity),
    ix: new Int32Array(capacity),
    iy: new Int32Array(capacity),
  };
}

/**
 * Adds a live marble at rest at `(x, y)` (fixed units) and returns its id.
 * @throws RangeError when the bodies are full.
 */
export function addMarble(b: Bodies, x: number, y: number): number {
  const id = b.count;
  if (id >= b.x.length) throw new RangeError("bodies are full");
  b.x[id] = x;
  b.y[id] = y;
  b.vx[id] = 0;
  b.vy[id] = 0;
  b.ix[id] = 0;
  b.iy[id] = 0;
  b.alive[id] = 1;
  b.count = id + 1;
  return id;
}

const slice = (a: Int32Array | Uint8Array, n: number): number[] => Array.from(a.subarray(0, n));

/** The JSON form of the first `count` marbles; `bodiesFromJson` restores it exactly. */
export function bodiesToJson(b: Bodies): BodiesJson {
  const n = b.count;
  return {
    x: slice(b.x, n),
    y: slice(b.y, n),
    vx: slice(b.vx, n),
    vy: slice(b.vy, n),
    alive: slice(b.alive, n),
    ix: slice(b.ix, n),
    iy: slice(b.iy, n),
  };
}

/**
 * Restores bodies from their JSON form, with room for `capacity` marbles (default: exactly the
 * stored count).
 * @throws RangeError when arrays differ in length, hold non-int32 values or `alive` values other
 * than 0/1, or exceed the capacity.
 */
export function bodiesFromJson(j: BodiesJson, capacity = j.x.length): Bodies {
  const n = j.x.length;
  const keys = ["x", "y", "vx", "vy", "alive", "ix", "iy"] as const;
  for (const k of keys) {
    const arr = j[k];
    if (!Array.isArray(arr) || arr.length !== n)
      throw new RangeError(`sim.${k} must be an array of length ${n}`);
    for (const v of arr)
      if (!Number.isInteger(v) || (v | 0) !== v) throw new RangeError(`sim.${k} holds ${v}`);
  }
  if (j.alive.some((v) => v !== 0 && v !== 1)) throw new RangeError("sim.alive must be 0 or 1");
  if (n > capacity) throw new RangeError(`${n} marbles exceed capacity ${capacity}`);
  const b = createBodies(capacity);
  b.count = n;
  b.x.set(j.x);
  b.y.set(j.y);
  b.vx.set(j.vx);
  b.vy.set(j.vy);
  b.alive.set(j.alive);
  b.ix.set(j.ix);
  b.iy.set(j.iy);
  return b;
}
