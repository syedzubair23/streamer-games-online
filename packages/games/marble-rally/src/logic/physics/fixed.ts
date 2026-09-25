/**
 * Integer helpers for the fixed-point solver.
 *
 * JavaScript numbers are IEEE doubles, which represent every integer below 2^53 exactly. The
 * solver keeps every value integral and every intermediate product below 2^53 (world
 * coordinates are below 2^18, normals below 2^13, so products stay below 2^40). Integer
 * division truncates toward zero with {@link idiv}; that is exact for such operands because a
 * correctly rounded IEEE quotient of two integers below 2^53 never crosses an integer boundary.
 *
 * @module
 */
import { NORM_ONE } from "./constants.ts";

/** Integer division truncating toward zero (like C `/`). `b` must be non-zero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/**
 * Floor of the square root of a non-negative integer below 2^53. `Math.sqrt` is correctly
 * rounded (IEEE 754), and the correction steps make the result exact regardless.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/**
 * `n * s / NORM_ONE`, rounded to nearest with halves away from zero (symmetric in sign): a
 * vector component along a 1/4096 unit normal, for pushes and velocity changes.
 */
export function roundNorm(n: number, s: number): number {
  const p = n * s;
  const q = Math.floor(Math.abs(p) / NORM_ONE + 0.5);
  return p < 0 ? -q : q;
}
