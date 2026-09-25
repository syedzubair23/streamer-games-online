/**
 * The Marble Rally solver: deterministic fixed-point 2D circles against capsule segments, pegs
 * and arcs, with marble–marble contacts (docs/specs/marble-rally.md "Physics").
 *
 * One {@link step} is one 60 Hz tick:
 *
 * 1. **forces**: every live marble gets its one-tick velocity add (`ix`, `iy`), the wind and
 *    the gravity; the adds are then cleared;
 * 2. {@link SUBSTEPS} substeps, each:
 *    a. speed cap (`|v| < 96`), then move by this substep's share of `v` (shares sum to `v`);
 *    b. **marble pairs** from a uniform 128-unit grid, in ascending `(i, j)` id order: the
 *       overlap is split equally between the two marbles;
 *    c. **static contacts** per marble in ascending id and collider order, then the world
 *       bounds: each marble is pushed out along the contact normal;
 *    d. **velocity from correction**: a marble whose position was corrected gets the correction
 *       as velocity (position-based dynamics, capped at the speed cap), so a blocked marble
 *       stops instead of storing gravity as phantom speed;
 *    e. **velocity pass** over the substep's contacts, judged by the approach speed from
 *       *before* the substep: impacts faster than {@link REST_VN} bounce with e = 3/4 between
 *       marbles and e = 5/8 against walls, and walls take 1/16 of the tangential speed;
 *       slower (resting) contacts end with zero normal speed and roll without friction;
 *    e′. **contact energy guard**: per island of touching marbles, contacts may not add
 *       mechanical energy beyond the integer-rounding allowance (see `limitContactEnergy`);
 *    f. **zone lines** crossed by a centre during the substep (gates, finish, boosts) become
 *       events; forward boost crossings add their velocity.
 *
 * Determinism: every value is an integer and every operation is exact integer arithmetic (see
 * `fixed.ts`), iteration orders are fixed, and nothing reads a clock or a random source. The
 * same bodies, track and inputs always produce bit-identical bodies and events.
 *
 * Energy: gravity is integrated semi-implicitly (it never adds energy on its own); every
 * velocity-pass response is checked exactly in integers so it cannot exceed the energy the
 * marble (or pair) had before the substep or after its correction; and the contact energy
 * guard makes sure the projection cannot lift a pile for free. Only the one-tick velocity adds,
 * the wind and boosts add energy (spec T3).
 *
 * Tunnelling: the per-substep move is at most 48 fixed units against a marble radius of 704,
 * and a segment's or arc's contact side comes from the marble's position **before** the
 * substep, so a marble shoved past a thin wall is pushed back to the side it came from.
 *
 * @module
 */
import type { Bodies } from "./bodies.ts";
import {
  CELL_SHIFT,
  FRICTION_DIV,
  GRAVITY,
  GRID_COLS,
  GRID_ROWS,
  MARBLE_R,
  MAX_MARBLES,
  NORM_ONE,
  PAIR_E_DEN,
  PAIR_E_NUM,
  REST_VN,
  SPEED_CAP,
  SUBSTEPS,
  WALL_E_DEN,
  WALL_E_NUM,
  WORLD_H,
  WORLD_W,
} from "./constants.ts";
import { isqrt, roundNorm } from "./fixed.ts";
import { ZONE_BOOST, type CompiledTrack } from "./track.ts";

/** Ints per event in {@link StepEvents.data}. */
export const EVENT_STRIDE = 5;

/**
 * Zone-line crossings from the last step, in order of substep, then marble id, then line.
 * Event `e` is `data[e*5 .. e*5+4]` = `kind` (`ZONE_GATE` / `ZONE_FINISH` / `ZONE_BOOST`),
 * `index` (gate or boost number), `marble` id, `dir` (+1 forward = left-to-right of the line,
 * −1 backward) and `substep`. The buffer is reused by the next step.
 */
export interface StepEvents {
  count: number;
  data: Int32Array;
}

/** Per-step inputs besides the bodies' own velocity adds. */
export interface StepOptions {
  /** Gravity along y, fixed units per tick² (default −3). 0 gives a closed-box test world. */
  gravity?: number;
  /** Horizontal wind on every live marble, fixed units per tick² (R8: ±2). */
  windX?: number;
}

/** A solver bound to one compiled track, with reusable scratch buffers for its capacity. */
export interface Solver {
  readonly track: CompiledTrack;
  readonly capacity: number;
  readonly events: StepEvents;
  /** @internal scratch buffers; not part of the simulation state */
  readonly s: Scratch;
}

interface Scratch {
  /** Positions before the substep's move (contact sides, zone lines). */
  px: Int32Array;
  py: Int32Array;
  /** Positions right after the move (the correction is the difference to the final position). */
  mx: Int32Array;
  my: Int32Array;
  /** Velocities before the substep (approach speeds for the velocity pass). */
  vpx: Int32Array;
  vpy: Int32Array;
  /** Per marble: its grid cell this substep, or −1 when not alive. */
  cellOf: Int32Array;
  /** `cell << ID_BITS | id` for the live marbles, sorted: grouped by cell, ids ascending. */
  keys: Int32Array;
  /** Per cell: the range of `keys` holding its marbles, valid when `cellStamp[c] === stamp`. */
  cellBegin: Int32Array;
  cellEnd: Int32Array;
  cellStamp: Int32Array;
  stamp: number;
  /** Pair candidates of one marble, ascending. */
  cand: Int32Array;
  /** The substep's candidate pairs `i, j`, in ascending `(i, j)` order. */
  cp: Int32Array;
  /** Contact islands (union–find parents) and their energy sums for the contact guard. */
  parent: Int32Array;
  idelta: Float64Array;
  ikin: Float64Array;
  /** The substep's contacts: pairs `i, j, nx, ny`; walls `i, nx, ny`. */
  pairs: Int32Array;
  pairCount: number;
  walls: Int32Array;
  wallCount: number;
}

const NCELLS = GRID_COLS * GRID_ROWS;
const R = MARBLE_R;
const TWO_R = 2 * MARBLE_R;
const CAP2 = SPEED_CAP * SPEED_CAP;
const COL_MAX = GRID_COLS - 1;
const ROW_MAX = GRID_ROWS - 1;
/** Bits for a marble id in a grid key (ids < 1024, above the 1000 hard cap). */
const ID_BITS = 10;
const ID_MASK = (1 << ID_BITS) - 1;

/**
 * Creates a solver for `track` that can step up to `capacity` marbles.
 * @throws RangeError unless `0 ≤ capacity ≤ 1000`.
 */
export function createSolver(track: CompiledTrack, capacity: number): Solver {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_MARBLES)
    throw new RangeError(`capacity must be an integer in [0, ${MAX_MARBLES}]`);
  const buf = (): Int32Array => new Int32Array(capacity);
  return {
    track,
    capacity,
    events: { count: 0, data: new Int32Array(EVENT_STRIDE * 64) },
    s: {
      px: buf(),
      py: buf(),
      mx: buf(),
      my: buf(),
      vpx: buf(),
      vpy: buf(),
      cellOf: buf(),
      keys: buf(),
      cellBegin: new Int32Array(NCELLS),
      cellEnd: new Int32Array(NCELLS),
      cellStamp: new Int32Array(NCELLS),
      stamp: 0,
      cand: buf(),
      cp: new Int32Array(2 * 1024),
      parent: buf(),
      idelta: new Float64Array(capacity),
      ikin: new Float64Array(capacity),
      pairs: new Int32Array(4 * 256),
      pairCount: 0,
      walls: new Int32Array(3 * 256),
      wallCount: 0,
    },
  };
}

function grow(a: Int32Array): Int32Array {
  const g = new Int32Array(a.length * 2);
  g.set(a);
  return g;
}

function pushEvent(
  ev: StepEvents,
  kind: number,
  index: number,
  marble: number,
  dir: number,
  sub: number,
): void {
  let o = ev.count * EVENT_STRIDE;
  if (o + EVENT_STRIDE > ev.data.length) ev.data = grow(ev.data);
  const d = ev.data;
  d[o++] = kind;
  d[o++] = index;
  d[o++] = marble;
  d[o++] = dir;
  d[o] = sub;
  ev.count++;
}

/**
 * The scratch of the step in progress. Module state owned by {@link step}: the solver is
 * synchronous, so no two steps interleave.
 */
let cur: Scratch;
/**
 * Per marble and substep under gravity, the `|v|²` rise the contact guard tolerates as integer
 * rounding: `|v|²` 1 per substep is ½ energy unit, so 1 unit per marble per tick (spec T3).
 */
const ROUNDING_ALLOWANCE = 1;
/**
 * Contact slop, fixed units: a marble within this distance of touching counts as in contact
 * (recorded for the velocity pass) without being pushed, so resting contacts stay resolved.
 */
const TOUCH = 4;

/** Caps marble `i`'s speed strictly below {@link SPEED_CAP}. */
function capSpeed(vx: Int32Array, vy: Int32Array, i: number): void {
  const x = vx[i]!;
  const y = vy[i]!;
  const s2 = x * x + y * y;
  if (s2 <= CAP2) return;
  const d = isqrt(s2) + 1;
  vx[i] = Math.trunc((x * SPEED_CAP) / d);
  vy[i] = Math.trunc((y * SPEED_CAP) / d);
}

/**
 * A static contact of marble `i`: push out by `pen` along the unit normal `(nx, ny)` (1/4096,
 * pointing away from the wall) and record it for the velocity pass.
 */
function wallHit(b: Bodies, i: number, nx: number, ny: number, pen: number): void {
  if (pen > 0) {
    b.x[i] = b.x[i]! + roundNorm(nx, pen);
    b.y[i] = b.y[i]! + roundNorm(ny, pen);
  }
  const sc = cur;
  let o = sc.wallCount * 3;
  if (o + 3 > sc.walls.length) sc.walls = grow(sc.walls);
  const w = sc.walls;
  w[o++] = i;
  w[o++] = nx;
  w[o] = ny;
  sc.wallCount++;
}

/** Contact of marble `i` with a static circle (peg or cap) of radius `rr` at `(cx, cy)`. */
function circleHit(b: Bodies, i: number, cx: number, cy: number, rr: number): void {
  const dx = b.x[i]! - cx;
  const dy = b.y[i]! - cy;
  const lim = R + rr;
  const d2 = dx * dx + dy * dy;
  const reach = lim + TOUCH;
  if (d2 >= reach * reach) return;
  const d = isqrt(d2);
  if (d === 0) {
    wallHit(b, i, 0, NORM_ONE, lim);
    return;
  }
  wallHit(b, i, Math.trunc((dx * NORM_ONE) / d), Math.trunc((dy * NORM_ONE) / d), lim - d);
}

function segmentHit(
  b: Bodies,
  i: number,
  f: Float64Array,
  o: number,
  prevX: number,
  prevY: number,
): void {
  const ax = f[o]!;
  const ay = f[o + 1]!;
  const h = f[o + 4]!;
  const dx = f[o + 5]!;
  const dy = f[o + 6]!;
  const len2 = f[o + 7]!;
  const px = b.x[i]! - ax;
  const py = b.y[i]! - ay;
  const t = px * dx + py * dy;
  if (t <= 0) return circleHit(b, i, ax, ay, h);
  if (t >= len2) return circleHit(b, i, f[o + 2]!, f[o + 3]!, h);
  const lim = R + h;
  const cross = dx * py - dy * px;
  const sd = Math.trunc(cross / f[o + 10]!);
  // The contact side is the side the marble was on before this substep: a marble shoved past
  // the wall (d < 0) is pushed back instead of through.
  const pc = dx * (prevY - ay) - dy * (prevX - ax);
  const side = pc > 0 ? 1 : pc < 0 ? -1 : cross >= 0 ? 1 : -1;
  const d = side * sd;
  if (d >= lim + TOUCH) return;
  wallHit(b, i, side * f[o + 8]!, side * f[o + 9]!, lim - d);
}

function arcHit(
  b: Bodies,
  i: number,
  f: Float64Array,
  o: number,
  prevX: number,
  prevY: number,
): void {
  const cx = f[o]!;
  const cy = f[o + 1]!;
  const r = f[o + 2]!;
  const lim = R + f[o + 3]!;
  const dx = b.x[i]! - cx;
  const dy = b.y[i]! - cy;
  const d2 = dx * dx + dy * dy;
  const outer = r + lim + TOUCH;
  if (d2 >= outer * outer) return;
  const inner = r - lim - TOUCH;
  if (inner > 0 && d2 <= inner * inner) return;
  const mode = f[o + 8]!;
  if (mode !== 0) {
    const ax = f[o + 4]!;
    const ay = f[o + 5]!;
    const bx = f[o + 6]!;
    const by = f[o + 7]!;
    if (mode === 1) {
      if (ax * dy - ay * dx < 0 || dx * by - dy * bx < 0) return;
    } else if (bx * dy - by * dx > 0 && dx * ay - dy * ax > 0) return;
  }
  const d = isqrt(d2);
  if (d === 0) return;
  const pdx = prevX - cx;
  const pdy = prevY - cy;
  const outside = pdx * pdx + pdy * pdy >= r * r;
  const sd = d - r;
  const pen = outside ? lim - sd : lim + sd;
  if (pen <= -TOUCH) return;
  const s = outside ? NORM_ONE : -NORM_ONE;
  wallHit(b, i, Math.trunc((dx * s) / d), Math.trunc((dy * s) / d), pen);
}

/** Keeps marble `i` inside the world. */
function boundsHit(b: Bodies, i: number): void {
  const lo = R + TOUCH;
  const x = b.x[i]!;
  if (x < lo) wallHit(b, i, NORM_ONE, 0, R - x);
  else if (x > WORLD_W - lo) wallHit(b, i, -NORM_ONE, 0, x - (WORLD_W - R));
  const y = b.y[i]!;
  if (y < lo) wallHit(b, i, 0, NORM_ONE, R - y);
  else if (y > WORLD_H - lo) wallHit(b, i, 0, -NORM_ONE, y - (WORLD_H - R));
}

/** Marble pair `(i, j)`, `i < j`: each is pushed out by half the overlap (rounded up). */
function pairHit(b: Bodies, i: number, j: number): void {
  const X = b.x;
  const Y = b.y;
  const dx = X[j]! - X[i]!;
  const dy = Y[j]! - Y[i]!;
  const d2 = dx * dx + dy * dy;
  const reach = TWO_R + TOUCH;
  if (d2 >= reach * reach) return;
  const d = isqrt(d2);
  let nx: number;
  let ny: number;
  if (d === 0) {
    nx = 0;
    ny = NORM_ONE; // coincident centres: the higher id goes up (deterministic)
  } else {
    nx = Math.trunc((dx * NORM_ONE) / d);
    ny = Math.trunc((dy * NORM_ONE) / d);
  }
  const half = (TWO_R - d) >> 1;
  if (half > 0) {
    const px = roundNorm(nx, half);
    const py = roundNorm(ny, half);
    X[i] = X[i]! - px;
    Y[i] = Y[i]! - py;
    X[j] = X[j]! + px;
    Y[j] = Y[j]! + py;
  }
  const sc = cur;
  let o = sc.pairCount * 4;
  if (o + 4 > sc.pairs.length) sc.pairs = grow(sc.pairs);
  const p = sc.pairs;
  p[o++] = i;
  p[o++] = j;
  p[o++] = nx;
  p[o] = ny;
  sc.pairCount++;
}

/**
 * Velocity pass for a wall contact. With `vnPre` the approach speed before the substep and
 * `vn` the current one: an impact (`vnPre < −REST_VN`) leaves with 5/8 of `vnPre` and loses
 * 1/16 of its tangential speed; a resting approach ends with zero normal speed; a marble that
 * was already separating only has a new approach cancelled.
 */
function wallVelocity(VX: Int32Array, VY: Int32Array, i: number, nx: number, ny: number): void {
  const sc = cur;
  const pvx = sc.vpx[i]!;
  const pvy = sc.vpy[i]!;
  const vnPre = Math.floor((pvx * nx + pvy * ny) / NORM_ONE);
  const vx = VX[i]!;
  const vy = VY[i]!;
  const vn = Math.floor((vx * nx + vy * ny) / NORM_ONE);
  if (vnPre >= 0 && vn >= 0) return;
  let tx = vx - roundNorm(nx, vn);
  let ty = vy - roundNorm(ny, vn);
  if (vnPre < -REST_VN) {
    tx -= Math.trunc(tx / FRICTION_DIV);
    ty -= Math.trunc(ty / FRICTION_DIV);
    const out = Math.trunc((-vnPre * WALL_E_NUM) / WALL_E_DEN);
    tx += roundNorm(nx, out);
    ty += roundNorm(ny, out);
  }
  const limit = Math.max(vx * vx + vy * vy, pvx * pvx + pvy * pvy);
  while (tx * tx + ty * ty > limit) {
    if (Math.abs(tx) >= Math.abs(ty)) tx -= Math.sign(tx);
    else ty -= Math.sign(ty);
  }
  VX[i] = tx;
  VY[i] = ty;
}

/**
 * Velocity pass for a marble pair, on the relative normal speed: an impact separates at 3/4 of
 * the approach speed from before the substep, a resting approach ends at zero, and a pair that
 * was already separating only has a new approach cancelled. Equal and opposite changes, so
 * momentum is conserved exactly.
 */
function pairVelocity(
  VX: Int32Array,
  VY: Int32Array,
  i: number,
  j: number,
  nx: number,
  ny: number,
): void {
  const sc = cur;
  const pix = sc.vpx[i]!;
  const piy = sc.vpy[i]!;
  const pjx = sc.vpx[j]!;
  const pjy = sc.vpy[j]!;
  const vnPre = Math.floor(((pjx - pix) * nx + (pjy - piy) * ny) / NORM_ONE);
  const wx = VX[j]! - VX[i]!;
  const wy = VY[j]! - VY[i]!;
  const vn = Math.floor((wx * nx + wy * ny) / NORM_ONE);
  let target: number;
  if (vnPre < -REST_VN) target = Math.trunc((-vnPre * PAIR_E_NUM) / PAIR_E_DEN);
  else if (vnPre < 0 || vn < 0) target = 0;
  else return;
  const J = Math.trunc((target - vn) / 2);
  if (J === 0) return;
  let jx = roundNorm(nx, J);
  let jy = roundNorm(ny, J);
  const ix = VX[i]!;
  const iy = VY[i]!;
  const jvx = VX[j]!;
  const jvy = VY[j]!;
  const now = ix * ix + iy * iy + jvx * jvx + jvy * jvy;
  const limit = Math.max(now, pix * pix + piy * piy + pjx * pjx + pjy * pjy);
  // new KE = now + 2|j|² + 2 j·w (i loses j, j gains j); halve j until within the limit
  while ((jx !== 0 || jy !== 0) && now + 2 * (jx * jx + jy * jy + jx * wx + jy * wy) > limit) {
    jx = Math.trunc(jx / 2);
    jy = Math.trunc(jy / 2);
  }
  VX[i] = ix - jx;
  VY[i] = iy - jy;
  VX[j] = jvx + jx;
  VY[j] = jvy + jy;
}

function findRoot(parent: Int32Array, i: number): number {
  let r = i;
  while (parent[r] !== r) r = parent[r]!;
  while (parent[i] !== r) {
    const next = parent[i]!;
    parent[i] = r;
    i = next;
  }
  return r;
}

/**
 * Energy guard for the contact phase of a substep: **contacts do no positive work**. Marbles
 * touching each other form islands (union–find over the recorded pair contacts; a marble that
 * only touches walls is its own island). For every island, compares its marbles' `|v|²` now
 * with before the substep, plus the lift of their corrections (`−2g·Δy`, in `|v|²` units).
 * When that sum is positive, the projection lifted marbles without a matching loss (a pile
 * settling, a squeeze), so the island's velocities are scaled by one common factor to remove
 * the excess. Rolling, bouncing and flowing marbles lose energy in contacts anyway and are
 * untouched.
 */
function limitContactEnergy(b: Bodies, g: number): void {
  const sc = cur;
  const n = b.count;
  const { alive, vx: VX, vy: VY, x: X, y: Y } = b;
  const { mx: MX, my: MY, vpx: VPX, vpy: VPY, parent, idelta, ikin } = sc;
  for (let i = 0; i < n; i++) {
    parent[i] = i;
    idelta[i] = 0;
    ikin[i] = 0;
  }
  const P = sc.pairs;
  for (let k = 0, o = 0; k < sc.pairCount; k++, o += 4) {
    const ri = findRoot(parent, P[o]!);
    const rj = findRoot(parent, P[o + 1]!);
    if (ri < rj) parent[rj] = ri;
    else if (rj < ri) parent[ri] = rj;
  }
  // Under gravity each marble may keep the integer-rounding allowance (positions are whole
  // fixed units, so a lift is quantised); without gravity the guard is strict.
  const allowance = g === 0 ? 0 : ROUNDING_ALLOWANCE;
  let any = false;
  for (let i = 0; i < n; i++) {
    if (alive[i] !== 1) continue;
    const vx = VX[i]!;
    const vy = VY[i]!;
    const px = VPX[i]!;
    const py = VPY[i]!;
    const dy = Y[i]! - MY[i]!;
    if (vx === px && vy === py && dy === 0 && X[i] === MX[i]) continue;
    const r = findRoot(parent, i);
    const k = vx * vx + vy * vy;
    ikin[r] = ikin[r]! + k;
    idelta[r] = idelta[r]! + k - (px * px + py * py) - 2 * g * dy - allowance;
    any = true;
  }
  if (!any) return;
  for (let r = 0; r < n; r++) {
    // Reuse idelta as the island's scale numerator, ikin as its denominator (0 = no change).
    const delta = idelta[r]!;
    const kin = ikin[r]!;
    if (parent[r] !== r || delta <= 0 || kin === 0) {
      ikin[r] = 0;
      continue;
    }
    idelta[r] = delta >= kin ? 0 : isqrt(kin - delta);
    ikin[r] = isqrt(kin) + 1;
  }
  for (let i = 0; i < n; i++) {
    if (alive[i] !== 1) continue;
    const r = findRoot(parent, i);
    const den = ikin[r]!;
    if (den === 0) continue;
    const num = idelta[r]!;
    VX[i] = Math.trunc((VX[i]! * num) / den);
    VY[i] = Math.trunc((VY[i]! * num) / den);
  }
}

const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Advances every live marble by one tick (60 Hz) against the solver's track. Mutates `bodies`
 * in place and returns the zone-line events of this step (a buffer reused by the next call).
 * @throws RangeError when `bodies.count` exceeds the solver's capacity.
 */
export function step(solver: Solver, bodies: Bodies, opts: StepOptions = {}): StepEvents {
  const n = bodies.count;
  if (n > solver.capacity)
    throw new RangeError(`${n} marbles exceed solver capacity ${solver.capacity}`);
  const g = opts.gravity ?? GRAVITY;
  const wind = opts.windX ?? 0;
  const { x: X, y: Y, vx: VX, vy: VY, alive, ix: IX, iy: IY } = bodies;
  const sc = solver.s;
  cur = sc;
  const {
    px: PX,
    py: PY,
    mx: MX,
    my: MY,
    vpx: VPX,
    vpy: VPY,
    cellOf,
    keys,
    cellBegin,
    cellEnd,
    cellStamp,
    cand,
  } = sc;
  const track = solver.track;
  const kind = track.kind;
  const f = track.data;
  const tStart = track.cellStart;
  const tItems = track.cellItems;
  const lineCount = track.lineCount;
  const lineKind = track.lineKind;
  const lineIndex = track.lineIndex;
  const ld = track.lineData;
  const ev = solver.events;
  ev.count = 0;

  // 1. forces
  for (let i = 0; i < n; i++) {
    if (alive[i] === 1) {
      VX[i] = VX[i]! + IX[i]! + wind;
      VY[i] = VY[i]! + IY[i]! + g;
    }
    IX[i] = 0;
    IY[i] = 0;
  }

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    sc.pairCount = 0;
    sc.wallCount = 0;

    // a. cap + move
    for (let i = 0; i < n; i++) {
      if (alive[i] !== 1) continue;
      capSpeed(VX, VY, i);
      const vx = VX[i]!;
      const vy = VY[i]!;
      VPX[i] = vx;
      VPY[i] = vy;
      PX[i] = X[i]!;
      PY[i] = Y[i]!;
      const x = X[i]! + Math.trunc((vx * (sub + 1)) / SUBSTEPS) - Math.trunc((vx * sub) / SUBSTEPS);
      const y = Y[i]! + Math.trunc((vy * (sub + 1)) / SUBSTEPS) - Math.trunc((vy * sub) / SUBSTEPS);
      X[i] = x;
      Y[i] = y;
      MX[i] = x;
      MY[i] = y;
    }

    // b. dynamic grid: live marbles sorted by (cell, id); no per-cell clearing (stamped ranges);
    //    candidate pairs (i < j in neighbouring cells) listed once per substep
    let live = 0;
    let cpCount = 0;
    for (let i = 0; i < n; i++) {
      if (alive[i] !== 1) {
        cellOf[i] = -1;
        continue;
      }
      const col = Math.min(COL_MAX, Math.max(0, X[i]! >> CELL_SHIFT));
      const row = Math.min(ROW_MAX, Math.max(0, Y[i]! >> CELL_SHIFT));
      const c = row * GRID_COLS + col;
      cellOf[i] = c;
      keys[live++] = (c << ID_BITS) | i;
    }
    const sortedKeys = keys.subarray(0, live);
    sortedKeys.sort();
    if (sc.stamp >= 0x3fffffff) {
      cellStamp.fill(0);
      sc.stamp = 0;
    }
    const stamp = ++sc.stamp;
    for (let k = 0; k < live; k++) {
      const c = keys[k]! >> ID_BITS;
      if (cellStamp[c] !== stamp) {
        cellStamp[c] = stamp;
        cellBegin[c] = k;
      }
      cellEnd[c] = k + 1;
    }
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]!;
      if (c < 0) continue;
      const col = c % GRID_COLS;
      const row = (c - col) / GRID_COLS;
      let m = 0;
      const r0 = row > 0 ? row - 1 : 0;
      const r1 = row < ROW_MAX ? row + 1 : ROW_MAX;
      const c0 = col > 0 ? col - 1 : 0;
      const c1 = col < COL_MAX ? col + 1 : COL_MAX;
      for (let rr = r0; rr <= r1; rr++)
        for (let cc = c0; cc <= c1; cc++) {
          const cell = rr * GRID_COLS + cc;
          if (cellStamp[cell] !== stamp) continue;
          const end = cellEnd[cell]!;
          for (let k = cellBegin[cell]!; k < end; k++) {
            const j = keys[k]! & ID_MASK;
            if (j <= i) continue;
            // insertion into the ascending candidate list
            let p = m++;
            while (p > 0 && cand[p - 1]! > j) {
              cand[p] = cand[p - 1]!;
              p--;
            }
            cand[p] = j;
          }
        }
      if (cpCount + m > sc.cp.length) {
        const g = new Int32Array(Math.max(sc.cp.length * 2, cpCount + m));
        g.set(sc.cp);
        sc.cp = g;
      }
      const cp = sc.cp;
      for (let k = 0; k < m; k++) {
        cp[cpCount++] = i;
        cp[cpCount++] = cand[k]!;
      }
    }

    // b/c. projection: marble pairs in ascending (i, j) order, then static contacts and
    //      bounds per marble (one pass: repeated passes make stacks stiffer, and the velocity
    //      derived from their corrections jitters)
    const cp = sc.cp;
    for (let k = 0; k < cpCount; k += 2) pairHit(bodies, cp[k]!, cp[k + 1]!);
    for (let i = 0; i < n; i++) {
      if (alive[i] !== 1) continue;
      const prevX = PX[i]!;
      const prevY = PY[i]!;
      const col = Math.min(COL_MAX, Math.max(0, X[i]! >> CELL_SHIFT));
      const row = Math.min(ROW_MAX, Math.max(0, Y[i]! >> CELL_SHIFT));
      const cell = row * GRID_COLS + col;
      const end = tStart[cell + 1]!;
      for (let k = tStart[cell]!; k < end; k++) {
        const id = tItems[k]!;
        const o = id * 12;
        const kd = kind[id]!;
        if (kd === 0) segmentHit(bodies, i, f, o, prevX, prevY);
        else if (kd === 1) circleHit(bodies, i, f[o]!, f[o + 1]!, f[o + 2]!);
        else arcHit(bodies, i, f, o, prevX, prevY);
      }
      boundsHit(bodies, i);
    }

    // d. velocity from correction (capped at the speed cap, so an overconstrained squeeze
    //    cannot turn a large push-back into a launch)
    for (let i = 0; i < n; i++) {
      if (alive[i] !== 1) continue;
      let dvx = (X[i]! - MX[i]!) * SUBSTEPS;
      let dvy = (Y[i]! - MY[i]!) * SUBSTEPS;
      if (dvx === 0 && dvy === 0) continue;
      const d2 = dvx * dvx + dvy * dvy;
      if (d2 > CAP2) {
        const d = isqrt(d2) + 1;
        dvx = Math.trunc((dvx * SPEED_CAP) / d);
        dvy = Math.trunc((dvy * SPEED_CAP) / d);
      }
      VX[i] = VX[i]! + dvx;
      VY[i] = VY[i]! + dvy;
    }

    // e. velocity pass
    const P = sc.pairs;
    for (let k = 0, o = 0; k < sc.pairCount; k++, o += 4)
      pairVelocity(VX, VY, P[o]!, P[o + 1]!, P[o + 2]!, P[o + 3]!);
    const W = sc.walls;
    for (let k = 0, o = 0; k < sc.wallCount; k++, o += 3)
      wallVelocity(VX, VY, W[o]!, W[o + 1]!, W[o + 2]!);

    // e'. contacts do no positive work: if this substep's corrections and responses together
    //     raised the mechanical energy of the marbles involved, their speeds are scaled down
    //     to pay it back (exact integers; see limitContactEnergy)
    limitContactEnergy(bodies, g);

    // f. zone lines
    if (lineCount === 0) continue;
    for (let i = 0; i < n; i++) {
      if (alive[i] !== 1) continue;
      const prevX = PX[i]!;
      const prevY = PY[i]!;
      const cx = X[i]!;
      const cy = Y[i]!;
      if (cx === prevX && cy === prevY) continue;
      for (let z = 0; z < lineCount; z++) {
        const o = z * 6;
        const ax = ld[o]!;
        const ay = ld[o + 1]!;
        const bx = ld[o + 2]!;
        const by = ld[o + 3]!;
        const ex = bx - ax;
        const ey = by - ay;
        const before = ex * (prevY - ay) - ey * (prevX - ax) > 0;
        const after = ex * (cy - ay) - ey * (cx - ax) > 0;
        if (before === after) continue;
        const mx = cx - prevX;
        const my = cy - prevY;
        const sa = sgn(mx * (ay - prevY) - my * (ax - prevX));
        const sb = sgn(mx * (by - prevY) - my * (bx - prevX));
        if (sa * sb > 0) continue;
        const dir = before ? 1 : -1;
        const kz = lineKind[z]!;
        pushEvent(ev, kz, lineIndex[z]!, i, dir, sub);
        if (kz === ZONE_BOOST && dir === 1) {
          VX[i] = VX[i]! + ld[o + 4]!;
          VY[i] = VY[i]! + ld[o + 5]!;
        }
      }
    }
  }
  return ev;
}

/**
 * Total mechanical energy of the live marbles in solver units (unit mass):
 * `Σ (vx² + vy²) / 2 − gravity · y`. Used by the energy-sanity tests and tuning tools.
 */
export function mechanicalEnergy(bodies: Bodies, gravity: number = GRAVITY): number {
  let e = 0;
  for (let i = 0; i < bodies.count; i++) {
    if (bodies.alive[i] !== 1) continue;
    const vx = bodies.vx[i]!;
    const vy = bodies.vy[i]!;
    e += (vx * vx + vy * vy) / 2 - gravity * bodies.y[i]!;
  }
  return e;
}
