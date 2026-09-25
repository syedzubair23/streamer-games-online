/**
 * A headless race runner for track tuning and the M9-00b track checks: the real solver on a
 * compiled course, with the spec's race-side rules that decide whether a track is playable:
 *
 * - marbles start in the first `n` tray slots (R2) and drop when the race starts;
 * - checkpoints count forward gate crossings in order; the finish counts only after gate 3 (R4);
 * - R6 stuck rule: progress rising by less than 16 in 4 s earns a deterministic ±x kick from
 *   `rng.fork("kick:" + id)`; 12 s without progress (the best progress rising by 16 or more)
 *   is a DNF (constants in `src/logic/tracks/tuning.ts`);
 * - optional R5 nudges: `(±24, +8)` per tick for 6 ticks, once per section, 3 per race;
 * - the race ends when every marble has finished or DNF'd, or at `raceMaxSec` (R3).
 *
 * The game logic proper (M9-01) owns these rules; this runner mirrors them so the tracks are
 * tuned against the behaviour the race will have. Deterministic for a given seed.
 */
import { createRng, type Rng } from "@sg/shared";
import {
  addMarble,
  createBodies,
  createSolver,
  EVENT_STRIDE,
  FP,
  TICK_HZ,
  WORLD_H,
  WORLD_W,
  ZONE_FINISH,
  ZONE_GATE,
  step,
  type Bodies,
} from "../src/logic/physics/index.ts";
import { GATES_PER_TRACK, trackProgress, type Course } from "../src/logic/tracks/course.ts";
import {
  DNF_TICKS,
  KICK_MIN,
  KICK_SPREAD,
  NUDGE_TICKS,
  NUDGE_X,
  NUDGE_Y,
  STUCK_MIN_RISE,
  STUCK_TICKS,
} from "../src/logic/tracks/tuning.ts";

export {
  DNF_TICKS,
  KICK_MIN,
  KICK_SPREAD,
  NUDGE_TICKS,
  NUDGE_X,
  NUDGE_Y,
  STUCK_MIN_RISE,
  STUCK_TICKS,
} from "../src/logic/tracks/tuning.ts";

/** Options for one race. */
export interface RaceOptions {
  entrants: number;
  seed: number | string;
  /** R3 `raceMaxSec` (default 120). */
  raceMaxSec?: number;
  /** Simulate audience nudges (default false). */
  nudges?: boolean;
  /** Called after every tick (for previews and debugging). */
  onTick?: (tick: number, bodies: Bodies) => void;
}

/** What happened in one race. */
export interface RaceResult {
  entrants: number;
  finished: number;
  dnf: number;
  /** The tick the race ended (all done, or the time cap). */
  endTick: number;
  /** Finish tick per marble, −1 for DNF. */
  finishTick: number[];
  /** Where each DNF'd marble was when it was stopped, world units. */
  dnfAt: [number, number][];
  /** The tick of each DNF, in the order of {@link RaceResult.dnfAt}. */
  dnfTick: number[];
  kicks: number;
  /** Marbles that crossed the finish without all 3 gates first (must be 0). */
  gateSkips: number;
  /** Marbles found outside the world at any tick (must be 0). */
  outOfWorld: number;
  /** Largest progress drop between consecutive ticks of one marble (ranking stability). */
  maxProgressDrop: number;
}

/** Runs one race on `course` and reports what happened. */
export function runRace(course: Course, opts: RaceOptions): RaceResult {
  const n = opts.entrants;
  const maxTicks = (opts.raceMaxSec ?? 120) * TICK_HZ;
  const solver = createSolver(course.physics, n);
  const b = createBodies(n);
  for (let i = 0; i < n; i++) addMarble(b, course.slots[2 * i]!, course.slots[2 * i + 1]!);

  const rng = createRng(opts.seed);
  const kickRng: (Rng | undefined)[] = new Array<Rng | undefined>(n);
  const progress = new Int32Array(n);
  const best = new Int32Array(n);
  const bestTick = new Int32Array(n);
  const anchor = new Int32Array(n);
  const anchorTick = new Int32Array(n);
  const cp = new Int32Array(n);
  const finishTick = new Array<number>(n).fill(-1);
  const done = new Uint8Array(n);
  const nudgeLeft = new Int32Array(n).fill(3);
  const nudgeAt = new Int32Array(n).fill(-1); // tick a scheduled nudge starts
  const nudgeDir = new Int8Array(n);
  const nudgeTicks = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    progress[i] = trackProgress(course, b.x[i]!, b.y[i]!, 0);
    best[i] = progress[i]!;
    anchor[i] = progress[i]!;
  }
  const scheduleNudge = (i: number, tick: number): void => {
    if (!opts.nudges || nudgeLeft[i]! <= 0 || !rng.bool(0.6)) return;
    nudgeAt[i] = tick + TICK_HZ + rng.int(8 * TICK_HZ);
    nudgeDir[i] = rng.bool() ? 1 : -1;
  };
  for (let i = 0; i < n; i++) scheduleNudge(i, 0);

  const dnfAt: [number, number][] = [];
  const dnfTick: number[] = [];
  let remaining = n;
  let kicks = 0;
  let gateSkips = 0;
  let outOfWorld = 0;
  let maxDrop = 0;
  let tick = 0;
  const stop = (i: number): void => {
    b.alive[i] = 0;
    done[i] = 1;
    remaining--;
  };

  while (remaining > 0 && tick < maxTicks) {
    // Nudges (R5): a scheduled nudge fires for 6 ticks.
    if (opts.nudges)
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        if (nudgeAt[i] === tick) {
          nudgeLeft[i]!--;
          nudgeTicks[i] = NUDGE_TICKS;
          nudgeAt[i] = -1;
        }
        if (nudgeTicks[i]! > 0) {
          b.ix[i]! += nudgeDir[i]! * NUDGE_X;
          b.iy[i]! += NUDGE_Y;
          nudgeTicks[i]!--;
        }
      }
    const ev = step(solver, b);
    tick++;
    for (let e = 0; e < ev.count; e++) {
      const o = e * EVENT_STRIDE;
      const kind = ev.data[o]!;
      const idx = ev.data[o + 1]!;
      const m = ev.data[o + 2]!;
      const dir = ev.data[o + 3]!;
      if (done[m] || dir !== 1) continue;
      if (kind === ZONE_GATE && idx === cp[m]) {
        cp[m]!++;
        scheduleNudge(m, tick);
      } else if (kind === ZONE_FINISH) {
        if (cp[m]! < GATES_PER_TRACK) gateSkips++;
        finishTick[m] = tick;
        stop(m);
      }
    }
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const x = b.x[i]!;
      const y = b.y[i]!;
      if (x < 0 || x > WORLD_W || y < 0 || y > WORLD_H) outOfWorld++;
      const p = trackProgress(course, x, y, progress[i]);
      const drop = progress[i]! - p;
      if (drop > maxDrop) maxDrop = drop;
      progress[i] = p;
      if (p >= best[i]! + STUCK_MIN_RISE) {
        best[i] = p;
        bestTick[i] = tick;
      }
      if (tick - bestTick[i]! >= DNF_TICKS) {
        dnfAt.push([Math.round(x / FP), Math.round(y / FP)]);
        dnfTick.push(tick);
        stop(i);
        continue;
      }
      if (tick - anchorTick[i]! >= STUCK_TICKS) {
        if (p - anchor[i]! < STUCK_MIN_RISE) {
          const r = (kickRng[i] ??= rng.fork(`kick:${i}`));
          b.ix[i]! += (r.bool() ? 1 : -1) * (KICK_MIN + r.int(KICK_SPREAD));
          kicks++;
        }
        anchor[i] = p;
        anchorTick[i] = tick;
      }
    }
    opts.onTick?.(tick, b);
  }
  // Time cap: everyone still racing is a DNF.
  for (let i = 0; i < n; i++)
    if (!done[i]) {
      dnfAt.push([Math.round(b.x[i]! / FP), Math.round(b.y[i]! / FP)]);
      dnfTick.push(tick);
    }
  const finished = finishTick.filter((t) => t >= 0).length;
  return {
    entrants: n,
    finished,
    dnf: n - finished,
    endTick: tick,
    finishTick,
    dnfAt,
    dnfTick,
    kicks,
    gateSkips,
    outOfWorld,
    maxProgressDrop: maxDrop,
  };
}

/**
 * Puts a single marble at rest at `(x, y)` (world units), having passed `startCp` gates, and
 * runs it alone with the R6 kicks: the "no guaranteed-stuck spot" probe. A spot traps marbles
 * when a marble resting there never reaches the finish; the DNF timer (a race rule, not a
 * property of the spot) is off unless `dnf` is set.
 */
export function runSolo(
  course: Course,
  x: number,
  y: number,
  startCp: number,
  seed: number | string,
  raceMaxSec = 120,
  dnf = false,
): { finished: boolean; ticks: number; at: [number, number] } {
  const solver = createSolver(course.physics, 1);
  const b = createBodies(1);
  addMarble(b, x * FP, y * FP);
  const rng = createRng(seed).fork("kick:0");
  let cp = startCp;
  let progress = trackProgress(course, b.x[0]!, b.y[0]!);
  let best = progress;
  let bestTick = 0;
  let anchor = progress;
  let anchorTick = 0;
  for (let tick = 1; tick <= raceMaxSec * TICK_HZ; tick++) {
    const ev = step(solver, b);
    for (let e = 0; e < ev.count; e++) {
      const o = e * EVENT_STRIDE;
      if (ev.data[o + 3] !== 1) continue;
      if (ev.data[o] === ZONE_GATE && ev.data[o + 1] === cp) cp++;
      else if (ev.data[o] === ZONE_FINISH && cp >= GATES_PER_TRACK)
        return { finished: true, ticks: tick, at: [0, 0] };
    }
    progress = trackProgress(course, b.x[0]!, b.y[0]!, progress);
    if (progress >= best + STUCK_MIN_RISE) {
      best = progress;
      bestTick = tick;
    }
    const at: [number, number] = [Math.round(b.x[0]! / FP), Math.round(b.y[0]! / FP)];
    if (dnf && tick - bestTick >= DNF_TICKS) return { finished: false, ticks: tick, at };
    if (tick - anchorTick >= STUCK_TICKS) {
      if (progress - anchor < STUCK_MIN_RISE)
        b.ix[0]! += (rng.bool() ? 1 : -1) * (KICK_MIN + rng.int(KICK_SPREAD));
      anchor = progress;
      anchorTick = tick;
    }
  }
  return {
    finished: false,
    ticks: raceMaxSec * TICK_HZ,
    at: [Math.round(b.x[0]! / FP), Math.round(b.y[0]! / FP)],
  };
}
