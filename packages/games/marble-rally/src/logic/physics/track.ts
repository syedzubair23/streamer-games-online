/**
 * Static track geometry for the solver: the authored definition (world units, JSON-safe) and
 * its compiled, grid-indexed form (fixed units, typed arrays).
 *
 * Collider kinds:
 * - **segment**: a capsule from `a` to `b` with half-thickness `thick / 2` (ramps, walls,
 *   funnels). Its unit normal is precomputed at 1/4096.
 * - **circle**: a peg of radius `r` (also the end caps of arcs).
 * - **arc**: a ring of radius `r` around `c` with half-thickness `thick / 2`, swept
 *   counter-clockwise from direction `a` to direction `b` (curved chutes and cups). Directions
 *   are integer vectors, so no trigonometry is needed anywhere.
 *
 * Zone lines (`gates`, `finish`, `boost`) are not solid; the solver reports when a marble's
 * centre crosses them. A line from `a` to `b` is crossed **forward** when the marble moves from
 * its left side to its right side (for a line authored left-to-right, that is moving down).
 *
 * @module
 */
import {
  CELL,
  GRID_COLS,
  GRID_ROWS,
  FP,
  MARBLE_R,
  NORM_ONE,
  SPEED_CAP,
  SUBSTEPS,
  WORLD_H,
  WORLD_W,
} from "./constants.ts";
import { idiv, isqrt } from "./fixed.ts";

/** A capsule segment `[x1, y1, x2, y2, thick]` in world units. */
export type SegmentDef = readonly [number, number, number, number, number];
/** A peg `[x, y, r]` in world units. */
export type PegDef = readonly [number, number, number];
/**
 * An arc `[cx, cy, r, ax, ay, bx, by, thick]`: centre and radius in world units, then the start
 * and end directions as integer vectors (any length), swept counter-clockwise from `a` to `b`.
 * `a` parallel to `b` (same direction) is a full ring.
 */
export type ArcDef = readonly [number, number, number, number, number, number, number, number];
/** A zone line `[x1, y1, x2, y2]` in world units. */
export type LineDef = readonly [number, number, number, number];
/**
 * A boost line `[x1, y1, x2, y2, vx, vy]`: line in world units, velocity add in fixed units per
 * tick, applied once when a marble crosses the line forward.
 */
export type BoostDef = readonly [number, number, number, number, number, number];

/** Solver zones of a track (docs/specs/marble-rally.md "Bodies"). */
export interface ZonesDef {
  /** Velocity adds, applied on a forward crossing. */
  boost?: readonly BoostDef[];
  /** Funnel walls: solid segments like `segments`, kept separate for the visuals. */
  funnel?: readonly SegmentDef[];
  /** Checkpoint lines, in race order (R4: 3 per track). */
  gates?: readonly LineDef[];
  /** The finish line. */
  finish?: LineDef;
}

/** The physics part of an authored track (the track JSON may carry more, e.g. `visuals`). */
export interface TrackPhysicsDef {
  segments: readonly SegmentDef[];
  pegs?: readonly PegDef[];
  arcs?: readonly ArcDef[];
  zones?: ZonesDef;
}

/** Collider kind codes in {@link CompiledTrack.kind}. */
export const KIND_SEGMENT = 0;
/** A circle collider (peg or arc end cap). */
export const KIND_CIRCLE = 1;
/** An arc (ring sector) collider. */
export const KIND_ARC = 2;

/** Zone line kind codes in {@link CompiledTrack.lineKind} and in step events. */
export const ZONE_GATE = 0;
/** The finish line. */
export const ZONE_FINISH = 1;
/** A boost line. */
export const ZONE_BOOST = 2;

/** Number of `f64` slots per collider in {@link CompiledTrack.data}. */
export const COLLIDER_STRIDE = 12;

/**
 * A compiled track. Collider `k` occupies `data[k*12 .. k*12+11]`:
 *
 * | kind | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
 * |---|---|---|---|---|---|---|---|---|---|---|---|---|
 * | segment | ax | ay | bx | by | h | dx | dy | len² | nx | ny | len | – |
 * | circle | cx | cy | r | – | – | – | – | – | – | – | – | – |
 * | arc | cx | cy | r | h | ax | ay | bx | by | mode | – | – | – |
 *
 * `h` is the half-thickness, `n` the left unit normal at 1/4096, `len` the floor of the length, arc `mode` is 1 for a sweep up
 * to 180°, 2 for a larger sweep and 0 for a full ring. Every value is an integer.
 */
export interface CompiledTrack {
  /** Number of colliders. */
  count: number;
  kind: Uint8Array;
  data: Float64Array;
  /** CSR static broadphase: colliders near cell `c` are `items[start[c] .. start[c+1]-1]`. */
  cellStart: Int32Array;
  cellItems: Int32Array;
  /** Zone lines: `lineData[z*6 ..]` = ax, ay, bx, by, bvx, bvy (fixed; boost add for boosts). */
  lineCount: number;
  lineKind: Uint8Array;
  /** Index of the line within its kind (gate number, boost number; 0 for the finish). */
  lineIndex: Int32Array;
  lineData: Float64Array;
  /** Number of gates. */
  gateCount: number;
}

/** Thrown by {@link compileTrack} for geometry the solver cannot use. */
export class TrackError extends Error {
  override name = "TrackError";
}

const isInt = (v: number): boolean => Number.isSafeInteger(v);

function checkInts(label: string, values: readonly number[]): void {
  for (const v of values) if (!isInt(v)) throw new TrackError(`${label}: ${v} is not an integer`);
}

function checkPoint(label: string, x: number, y: number): void {
  if (x < 0 || x > WORLD_W || y < 0 || y > WORLD_H)
    throw new TrackError(`${label}: point (${x / FP}, ${y / FP}) is outside the world`);
}

/**
 * Largest distance a marble centre travels in one substep (speed cap) plus the largest single
 * positional correction we expect before the static pass; colliders are indexed into every cell
 * whose points could be within `R + h + margin` of them.
 */
const INDEX_MARGIN = Math.ceil(SPEED_CAP / SUBSTEPS) + MARBLE_R;

/** Squared distance from point `p` to segment `a–b` (integers, exact). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = (px - ax) * dx + (py - ay) * dy;
  if (len2 === 0 || t <= 0) return (px - ax) ** 2 + (py - ay) ** 2;
  if (t >= len2) return (px - bx) ** 2 + (py - by) ** 2;
  // Perpendicular distance² = cross² / len2, rounded down (conservative for indexing).
  const cross = dx * (py - ay) - dy * (px - ax);
  t = Math.floor((cross * cross) / len2);
  return t;
}

/**
 * Compiles an authored track into solver form: validates it, converts it to fixed units,
 * precomputes segment normals and arc end caps, and builds the static broadphase grid.
 * @throws TrackError on non-integer values, points outside the world, zero-length segments,
 * negative sizes or zero direction vectors.
 */
export function compileTrack(def: TrackPhysicsDef): CompiledTrack {
  const kinds: number[] = [];
  const data: number[] = [];
  const reach: number[] = []; // per collider: radius of influence beyond its geometry (fixed)

  const addSegment = (s: SegmentDef, label: string): void => {
    checkInts(label, s);
    const [x1, y1, x2, y2, thick] = s;
    if (thick < 0) throw new TrackError(`${label}: negative thickness`);
    const ax = x1 * FP;
    const ay = y1 * FP;
    const bx = x2 * FP;
    const by = y2 * FP;
    checkPoint(label, ax, ay);
    checkPoint(label, bx, by);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) throw new TrackError(`${label}: zero-length segment`);
    const len = isqrt(len2);
    const h = idiv(thick * FP, 2);
    kinds.push(0);
    const nx = idiv(-dy * NORM_ONE, len);
    const ny = idiv(dx * NORM_ONE, len);
    data.push(ax, ay, bx, by, h, dx, dy, len2, nx, ny, len, 0);
    reach.push(h);
  };
  const addCircle = (cx: number, cy: number, r: number): void => {
    kinds.push(1);
    data.push(cx, cy, r, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    reach.push(r);
  };

  def.segments.forEach((s, i) => addSegment(s, `segments[${i}]`));
  (def.zones?.funnel ?? []).forEach((s, i) => addSegment(s, `zones.funnel[${i}]`));
  (def.pegs ?? []).forEach((p, i) => {
    const label = `pegs[${i}]`;
    checkInts(label, p);
    const [x, y, r] = p;
    if (r < 0) throw new TrackError(`${label}: negative radius`);
    checkPoint(label, x * FP, y * FP);
    addCircle(x * FP, y * FP, r * FP);
  });
  (def.arcs ?? []).forEach((a, i) => {
    const label = `arcs[${i}]`;
    checkInts(label, a);
    const [cxU, cyU, rU, ax, ay, bx, by, thick] = a;
    if (rU <= 0) throw new TrackError(`${label}: radius must be positive`);
    if (thick < 0) throw new TrackError(`${label}: negative thickness`);
    if ((ax === 0 && ay === 0) || (bx === 0 && by === 0))
      throw new TrackError(`${label}: zero direction vector`);
    const cx = cxU * FP;
    const cy = cyU * FP;
    const r = rU * FP;
    const h = idiv(thick * FP, 2);
    checkPoint(label, cx, cy);
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    const mode = cross === 0 && dot > 0 ? 0 : cross > 0 ? 1 : 2;
    kinds.push(2);
    data.push(cx, cy, r, h, ax, ay, bx, by, mode, 0, 0, 0);
    reach.push(r + h); // indexed as a disc around the centre
    if (mode !== 0) {
      const la = isqrt(ax * ax + ay * ay);
      const lb = isqrt(bx * bx + by * by);
      const ex1 = cx + idiv(ax * r, la);
      const ey1 = cy + idiv(ay * r, la);
      const ex2 = cx + idiv(bx * r, lb);
      const ey2 = cy + idiv(by * r, lb);
      checkPoint(`${label} start`, ex1, ey1);
      checkPoint(`${label} end`, ex2, ey2);
      addCircle(ex1, ey1, h);
      addCircle(ex2, ey2, h);
    }
  });

  const count = kinds.length;
  const kind = Uint8Array.from(kinds);
  const f = Float64Array.from(data);

  // Static broadphase: bucket each collider into every cell whose area lies within its reach.
  const ncells = GRID_COLS * GRID_ROWS;
  const buckets: number[][] = Array.from({ length: ncells }, () => []);
  const halfCell = CELL / 2;
  const cellHalfDiag = isqrt(2 * halfCell * halfCell) + 1;
  for (let k = 0; k < count; k++) {
    const o = k * 12;
    const expand = reach[k]! + INDEX_MARGIN;
    let minX: number, minY: number, maxX: number, maxY: number;
    if (kind[k] === 0) {
      minX = Math.min(f[o]!, f[o + 2]!);
      maxX = Math.max(f[o]!, f[o + 2]!);
      minY = Math.min(f[o + 1]!, f[o + 3]!);
      maxY = Math.max(f[o + 1]!, f[o + 3]!);
    } else {
      minX = maxX = f[o]!;
      minY = maxY = f[o + 1]!;
    }
    const c0 = Math.max(0, Math.floor((minX - expand) / CELL));
    const c1 = Math.min(GRID_COLS - 1, Math.floor((maxX + expand) / CELL));
    const r0 = Math.max(0, Math.floor((minY - expand) / CELL));
    const r1 = Math.min(GRID_ROWS - 1, Math.floor((maxY + expand) / CELL));
    const lim = (expand + cellHalfDiag) ** 2;
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const px = col * CELL + halfCell;
        const py = row * CELL + halfCell;
        const d2 =
          kind[k] === 0
            ? segDist2(px, py, f[o]!, f[o + 1]!, f[o + 2]!, f[o + 3]!)
            : (px - f[o]!) ** 2 + (py - f[o + 1]!) ** 2;
        if (d2 > lim) continue;
        if (kind[k] === 2) {
          // Skip cells entirely inside the ring's hollow.
          const inner = f[o + 2]! - f[o + 3]! - INDEX_MARGIN - cellHalfDiag;
          if (inner > 0 && d2 < inner * inner) continue;
        }
        buckets[row * GRID_COLS + col]!.push(k);
      }
  }
  const cellStart = new Int32Array(ncells + 1);
  let total = 0;
  for (let c = 0; c < ncells; c++) {
    cellStart[c] = total;
    total += buckets[c]!.length;
  }
  cellStart[ncells] = total;
  const cellItems = new Int32Array(total);
  for (let c = 0; c < ncells; c++) cellItems.set(buckets[c]!, cellStart[c]!);

  // Zone lines.
  const lk: number[] = [];
  const li: number[] = [];
  const ld: number[] = [];
  const addLine = (l: readonly number[], kindCode: number, index: number, label: string): void => {
    checkInts(label, l);
    const [x1, y1, x2, y2] = l as [number, number, number, number];
    const ax = x1 * FP;
    const ay = y1 * FP;
    const bx = x2 * FP;
    const by = y2 * FP;
    checkPoint(label, ax, ay);
    checkPoint(label, bx, by);
    if (ax === bx && ay === by) throw new TrackError(`${label}: zero-length line`);
    lk.push(kindCode);
    li.push(index);
    ld.push(ax, ay, bx, by, l[4] ?? 0, l[5] ?? 0);
  };
  const gates = def.zones?.gates ?? [];
  gates.forEach((g, i) => addLine(g, ZONE_GATE, i, `zones.gates[${i}]`));
  if (def.zones?.finish) addLine(def.zones.finish, ZONE_FINISH, 0, "zones.finish");
  (def.zones?.boost ?? []).forEach((b, i) => addLine(b, ZONE_BOOST, i, `zones.boost[${i}]`));

  return {
    count,
    kind,
    data: f,
    cellStart,
    cellItems,
    lineCount: lk.length,
    lineKind: Uint8Array.from(lk),
    lineIndex: Int32Array.from(li),
    lineData: Float64Array.from(ld),
    gateCount: gates.length,
  };
}
