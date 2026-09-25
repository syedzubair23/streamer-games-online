/**
 * Springs (SPEC §13.4, research 03 §4.2): the five named presets and a tiny semi-implicit Euler
 * integrator stepped at a fixed rate, so a spring's path never depends on the frame rate (and a
 * scenario settled with fixed steps is reproducible).
 *
 * @module
 */
import type { SpringConfig, SpringName, SpringPresets } from "./types.ts";

/** The spring presets of SPEC §13.4 (stiffness / damping, mass 1). */
export const SPRINGS: SpringPresets = Object.freeze({
  snappy: Object.freeze({ stiffness: 520, damping: 34 }),
  bouncy: Object.freeze({ stiffness: 380, damping: 18 }),
  gentle: Object.freeze({ stiffness: 170, damping: 26 }),
  wobbly: Object.freeze({ stiffness: 240, damping: 12 }),
  camera: Object.freeze({ stiffness: 120, damping: 22 }),
});

/** Integration step (ms). Fixed, so results do not depend on the frame rate. */
export const SPRING_STEP_MS = 1000 / 240;
/** A spring is at rest when both its offset and its velocity are below this. */
export const SPRING_REST = 1e-4;

/** Resolves a preset name or passes a config through. */
export function resolveSpring(
  spring: SpringName | SpringConfig,
  presets: SpringPresets = SPRINGS,
): SpringConfig {
  if (typeof spring !== "string") return spring;
  const cfg = presets[spring] as SpringConfig | undefined;
  if (cfg === undefined) throw new RangeError(`unknown spring preset "${String(spring)}"`);
  return cfg;
}

/**
 * Advances one spring dimension by exactly one {@link SPRING_STEP_MS} step (semi-implicit
 * Euler: velocity first, then position). `state[i]` is the position and `vel[i]` the velocity;
 * both are updated in place, so stepping allocates nothing.
 */
export function stepSpring(
  state: Float64Array,
  vel: Float64Array,
  i: number,
  target: number,
  cfg: SpringConfig,
): void {
  const dt = SPRING_STEP_MS / 1000;
  const x = state[i] as number;
  const v = vel[i] as number;
  const mass = cfg.mass ?? 1;
  const accel = (-cfg.stiffness * (x - target) - cfg.damping * v) / mass;
  const nv = v + accel * dt;
  vel[i] = nv;
  state[i] = x + nv * dt;
}

/** Whether a spring dimension has come to rest at `target`. */
export function springAtRest(x: number, v: number, target: number, scale = 1): boolean {
  const eps = SPRING_REST * Math.max(1, Math.abs(scale));
  return Math.abs(x - target) < eps && Math.abs(v) < eps;
}

/**
 * The peak overshoot (fraction of the travel) of a spring released from rest, simulated with
 * the same integrator. Used by tests and by tooling that documents the presets.
 */
export function springOvershoot(cfg: SpringConfig): number {
  const s = new Float64Array([0]);
  const v = new Float64Array([0]);
  let peak = 0;
  for (let i = 0; i < 240 * 5; i++) {
    stepSpring(s, v, 0, 1, cfg);
    peak = Math.max(peak, s[0] as number);
    if (springAtRest(s[0] as number, v[0] as number, 1)) break;
  }
  return Math.max(0, peak - 1);
}
