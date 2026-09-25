/**
 * A track compiled for a race: the solver geometry, the start tray slots and the progress
 * metric along the authored centreline (R2, R4). Everything is integer maths in solver fixed
 * units (1/16 world unit), so the server's rankings are deterministic.
 *
 * @module
 */
import {
  compileTrack,
  FP,
  idiv,
  isqrt,
  MARBLE_RADIUS_UNITS,
  MAX_MARBLES,
  TrackError,
  WORLD_H_UNITS,
  WORLD_W_UNITS,
  type CompiledTrack,
  type LineDef,
} from "../physics/index.ts";
import { TRACK_IDS, type PieceSource, type TrackDef } from "./types.ts";

/** Progress runs from 0 at the start gate to this value at the end of the centreline (R4). */
export const PROGRESS_MAX = 10_000;
/** Clearance between neighbouring marbles in the start tray, world units. */
export const TRAY_GAP_UNITS = 2;
/** Gates per track (R4). */
export const GATES_PER_TRACK = 3;
/**
 * How far along the centreline (fixed units, each way) {@link trackProgress} searches from a
 * marble's previous progress. A marble moves under 6 units per tick, so 512 units is generous
 * while keeping a marble on a wide section from snapping onto a later level of the track.
 */
export const PROGRESS_WINDOW = 512 * FP;

/** A compiled track ready for a race. */
export interface Course {
  readonly def: TrackDef;
  /** The solver geometry. */
  readonly physics: CompiledTrack;
  /** Centreline vertices, fixed units. */
  readonly clx: Int32Array;
  readonly cly: Int32Array;
  /** Arc length from the start to vertex `i` (fixed units, floored per edge). */
  readonly cls: Float64Array;
  /** Total centreline length, fixed units. */
  readonly length: number;
  /** Progress (0–10000) where the centreline crosses gate `g`. */
  readonly gateProgress: readonly number[];
  /** Progress where the centreline crosses the finish line. */
  readonly finishProgress: number;
  /** Start slot centres `x0, y0, x1, y1, …` (fixed units), in fill order; see {@link traySlots}. */
  readonly slots: Int32Array;
  /** Number of start slots. At least the 1000-marble hard cap. */
  readonly trayCapacity: number;
}

/** Sign of the cross product of `b − a` and `p − a`: > 0 when `p` is left of `a → b`. */
const side = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
  Math.sign((bx - ax) * (py - ay) - (by - ay) * (px - ax));

/** Like {@link side}, but a point exactly on the line counts as left (not yet crossed). */
const lineSide = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number => (side(ax, ay, bx, by, px, py) < 0 ? -1 : 1);

/**
 * Where the centreline crosses the zone line `l`: the index of each centreline edge that crosses
 * it (from the line's left to its right is forward, +1; the other way −1), with the crossing's
 * arc length.
 */
function crossings(
  clx: Int32Array,
  cly: Int32Array,
  cls: Float64Array,
  l: LineDef,
): { dir: number; s: number }[] {
  const [x1, y1, x2, y2] = l.map((v) => v * FP) as [number, number, number, number];
  const out: { dir: number; s: number }[] = [];
  for (let i = 0; i + 1 < clx.length; i++) {
    const ax = clx[i]!;
    const ay = cly[i]!;
    const bx = clx[i + 1]!;
    const by = cly[i + 1]!;
    const sa = lineSide(x1, y1, x2, y2, ax, ay);
    const sb = lineSide(x1, y1, x2, y2, bx, by);
    if (sa === sb) continue;
    if (side(ax, ay, bx, by, x1, y1) === side(ax, ay, bx, by, x2, y2)) continue;
    // Arc length of the crossing: interpolate by the line-side distances (integers).
    const da = Math.abs((x2 - x1) * (ay - y1) - (y2 - y1) * (ax - x1));
    const db = Math.abs((x2 - x1) * (by - y1) - (y2 - y1) * (bx - x1));
    const edge = cls[i + 1]! - cls[i]!;
    out.push({ dir: sa > 0 ? 1 : -1, s: cls[i]! + Math.floor((edge * da) / (da + db)) });
  }
  return out;
}

const toProgress = (s: number, length: number): number =>
  Math.min(PROGRESS_MAX, Math.floor((s * PROGRESS_MAX) / length));

/**
 * The hexagonal start slots of a tray, bottom row first, each row left to right: centres rest
 * one marble radius plus the gap above the start gate, neighbours are `2R + gap` apart and odd
 * rows are offset by half a spacing (R2). Only rows whose centre is at or below `start.top`.
 */
export function traySlots(def: TrackDef): Int32Array {
  const [gx1, gy, gx2] = def.start.gate;
  const d = 2 * MARBLE_RADIUS_UNITS + TRAY_GAP_UNITS;
  const rowH = isqrt(d * d - (d * d) / 4); // √3/2 · d, floored: rows never overlap
  const x0 = gx1 + MARBLE_RADIUS_UNITS + TRAY_GAP_UNITS;
  const x1 = gx2 - MARBLE_RADIUS_UNITS - TRAY_GAP_UNITS;
  const out: number[] = [];
  for (let row = 0; ; row++) {
    const y = gy + MARBLE_RADIUS_UNITS + TRAY_GAP_UNITS + row * rowH;
    if (y > def.start.top) break;
    const off = row % 2 === 0 ? 0 : d / 2;
    for (let x = x0 + off; x <= x1; x += d) out.push(Math.floor(x * FP), y * FP);
  }
  return Int32Array.from(out);
}

function inWorld(x: number, y: number): boolean {
  return x >= 0 && x <= WORLD_W_UNITS && y >= 0 && y <= WORLD_H_UNITS;
}

function checkIntList(label: string, values: readonly number[]): void {
  for (const v of values)
    if (!Number.isSafeInteger(v)) throw new TrackError(`${label}: ${v} is not an integer`);
}

/**
 * Compiles and validates an authored track: the solver geometry (see `compileTrack`), the start
 * tray (a horizontal gate inside the world with room for the 1000-marble hard cap), the
 * centreline (from the start gate, crossing each of the 3 gates once forward and in order, then
 * the finish) and the visuals (every solid collider drawn by exactly one piece).
 * @throws TrackError describing the first problem found.
 */
export function compileCourse(def: TrackDef): Course {
  if (!(TRACK_IDS as readonly string[]).includes(def.id))
    throw new TrackError(`unknown track id "${def.id}"`);
  if (def.name.trim() === "") throw new TrackError(`${def.id}: empty name`);
  const physics = compileTrack(def);
  const gates = def.zones?.gates ?? [];
  const finish = def.zones?.finish;
  if (gates.length !== GATES_PER_TRACK)
    throw new TrackError(`${def.id}: needs ${GATES_PER_TRACK} gates, has ${gates.length}`);
  if (finish === undefined) throw new TrackError(`${def.id}: no finish line`);

  // Start tray.
  const [gx1, gy1, gx2, gy2] = def.start.gate;
  checkIntList(`${def.id} start`, [gx1, gy1, gx2, gy2, def.start.top]);
  if (gy1 !== gy2 || gx1 >= gx2)
    throw new TrackError(`${def.id}: start gate must run left to right`);
  if (!inWorld(gx1, gy1) || !inWorld(gx2, gy2) || !inWorld(gx1, def.start.top))
    throw new TrackError(`${def.id}: start tray outside the world`);
  const slots = traySlots(def);
  const trayCapacity = slots.length / 2;
  if (trayCapacity < MAX_MARBLES)
    throw new TrackError(`${def.id}: tray holds ${trayCapacity} marbles, needs ${MAX_MARBLES}`);

  // Centreline.
  const cl = def.centerline;
  if (cl.length < 2) throw new TrackError(`${def.id}: centreline needs 2 or more points`);
  cl.forEach((p, i) => {
    checkIntList(`${def.id} centerline[${i}]`, p);
    if (!inWorld(p[0], p[1])) throw new TrackError(`${def.id}: centerline[${i}] outside the world`);
  });
  const first = cl[0]!;
  if (first[1] !== gy1 || first[0] < gx1 || first[0] > gx2)
    throw new TrackError(`${def.id}: the centreline must start on the start gate`);
  const n = cl.length;
  const clx = new Int32Array(n);
  const cly = new Int32Array(n);
  const cls = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    clx[i] = cl[i]![0] * FP;
    cly[i] = cl[i]![1] * FP;
    if (i > 0) {
      const dx = clx[i]! - clx[i - 1]!;
      const dy = cly[i]! - cly[i - 1]!;
      if (dx === 0 && dy === 0) throw new TrackError(`${def.id}: centerline[${i}] repeats a point`);
      cls[i] = cls[i - 1]! + isqrt(dx * dx + dy * dy);
    }
  }
  const length = cls[n - 1]!;
  const gateProgress: number[] = [];
  let lastS = -1;
  gates.forEach((g, i) => {
    const xs = crossings(clx, cly, cls, g);
    if (xs.length !== 1 || xs[0]!.dir !== 1)
      throw new TrackError(`${def.id}: the centreline must cross gate ${i} once, forward`);
    if (xs[0]!.s <= lastS) throw new TrackError(`${def.id}: gate ${i} is out of order`);
    lastS = xs[0]!.s;
    gateProgress.push(toProgress(xs[0]!.s, length));
  });
  const fx = crossings(clx, cly, cls, finish);
  if (fx.length !== 1 || fx[0]!.dir !== 1 || fx[0]!.s <= lastS)
    throw new TrackError(`${def.id}: the centreline must cross the finish once, after the gates`);

  // Visuals: every solid collider drawn exactly once.
  const lists: Record<PieceSource, number> = {
    segments: def.segments.length,
    funnel: def.zones?.funnel?.length ?? 0,
    arcs: def.arcs?.length ?? 0,
    pegs: def.pegs?.length ?? 0,
  };
  const seen = new Set<string>();
  for (const p of def.visuals.pieces) {
    const key = `${p.src}[${p.index}]`;
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= lists[p.src])
      throw new TrackError(`${def.id}: piece ${key} has no collider`);
    if (!Number.isInteger(p.variant) || p.variant < 0)
      throw new TrackError(`${def.id}: piece ${key} has a bad variant`);
    if (seen.has(key)) throw new TrackError(`${def.id}: ${key} is drawn twice`);
    seen.add(key);
  }
  for (const [src, count] of Object.entries(lists))
    for (let i = 0; i < count; i++)
      if (!seen.has(`${src}[${i}]`)) throw new TrackError(`${def.id}: ${src}[${i}] is not drawn`);
  for (const t of def.visuals.trapdoors)
    if (!Number.isInteger(t) || t < 0 || t >= gates.length)
      throw new TrackError(`${def.id}: trapdoor ${t} is not a gate`);
  checkIntList(`${def.id} visuals`, [
    ...def.visuals.train.rail,
    ...def.visuals.flag,
    ...def.visuals.decor.flatMap((d) => [d.x, d.y, d.rot]),
  ]);
  if (!(def.visuals.train.periodSec > 0)) throw new TrackError(`${def.id}: bad train period`);

  return {
    def,
    physics,
    clx,
    cly,
    cls,
    length,
    gateProgress,
    finishProgress: toProgress(fx[0]!.s, length),
    slots,
    trayCapacity,
  };
}

/**
 * The race progress (R4) of a marble centre at `(x, y)` (fixed units): the distance along the
 * centreline to the nearest point on it, scaled to 0–10000.
 *
 * With `prev` (the marble's progress on the previous tick), only the part of the centreline
 * within {@link PROGRESS_WINDOW} of `prev` is searched, so a marble crossing a wide section
 * never snaps onto a later level of a zig-zag. Without it, the whole centreline is searched
 * (spawn, restore). Ties go to the earlier edge. Integer maths throughout.
 */
export function trackProgress(course: Course, x: number, y: number, prev?: number): number {
  const { clx, cly, cls, length } = course;
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  if (prev !== undefined) {
    const s = Math.floor((prev * length) / PROGRESS_MAX);
    lo = s - PROGRESS_WINDOW;
    hi = s + PROGRESS_WINDOW;
  }
  let best = Number.POSITIVE_INFINITY;
  let bestS = 0;
  for (let i = 0; i + 1 < clx.length; i++) {
    const s0 = cls[i]!;
    const s1 = cls[i + 1]!;
    if (s1 < lo || s0 > hi) continue;
    const ax = clx[i]!;
    const ay = cly[i]!;
    const dx = clx[i + 1]! - ax;
    const dy = cly[i + 1]! - ay;
    const len2 = dx * dx + dy * dy;
    const edge = s1 - s0;
    let t = (x - ax) * dx + (y - ay) * dy;
    if (t < 0) t = 0;
    else if (t > len2) t = len2;
    // Along-edge distance = t / |d|; the foot point = a + d · t / len2.
    let along = Math.min(edge, Math.floor(t / isqrt(len2)));
    let s = s0 + along;
    // Clamp to the search window so a far foot point cannot leap ahead.
    if (s > hi) {
      along = hi - s0;
      s = hi;
    } else if (s < lo) {
      along = lo - s0;
      s = lo;
    }
    const fx = ax + idiv(dx * along, edge);
    const fy = ay + idiv(dy * along, edge);
    const d2 = (x - fx) * (x - fx) + (y - fy) * (y - fy);
    if (d2 < best) {
      best = d2;
      bestS = s;
    }
  }
  return toProgress(Math.max(0, bestS), length);
}
