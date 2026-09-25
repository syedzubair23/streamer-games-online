/**
 * Marble Rally physics (ROADMAP M9-00): a deterministic fixed-point 2D solver for marbles
 * against capsule segments, pegs and arcs, with zone-line events.
 *
 * ```ts
 * const track = compileTrack(def);           // authored JSON → fixed-point colliders + grid
 * const solver = createSolver(track, 500);
 * const bodies = createBodies(500);
 * addMarble(bodies, 2048 * FP, 8000 * FP);
 * const events = step(solver, bodies);        // one 60 Hz tick
 * ```
 *
 * @module
 */
export * from "./constants.ts";
export { idiv, isqrt } from "./fixed.ts";
export * from "./bodies.ts";
export * from "./track.ts";
export {
  createSolver,
  EVENT_STRIDE,
  mechanicalEnergy,
  step,
  type Solver,
  type StepEvents,
  type StepOptions,
} from "./solver.ts";
