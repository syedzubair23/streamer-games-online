/**
 * Lathe-turned pieces (SPEC §13.6, research 03 §6): pawns, tokens, pegs and beads from ~8-point
 * profiles, smoothed with a centripetal Catmull-Rom spline so a handful of control points gives
 * a soft, toy-like silhouette. Segment counts follow the quality tier.
 *
 * @module
 */
import { LatheGeometry, Vector2 } from "three";
import { TIERS } from "../quality.ts";
import type { QualityTier } from "../types.ts";

/** A profile point: `[radius, height]`, bottom to top. The first and last radius should be 0. */
export type ProfilePoint = readonly [number, number];

/** Built-in profiles (unit height ≈ 1, radius ≤ 0.5). */
export const PROFILES: Readonly<
  Record<"pawn" | "token" | "peg" | "bead", readonly ProfilePoint[]>
> = Object.freeze({
  /** A classic board-game pawn: flared base, waist, collar, round head. */
  pawn: Object.freeze([
    [0, 0],
    [0.36, 0],
    [0.38, 0.06],
    [0.3, 0.14],
    [0.17, 0.36],
    [0.13, 0.55],
    [0.22, 0.6],
    [0.13, 0.66],
    [0.2, 0.76],
    [0.19, 0.9],
    [0.1, 0.98],
    [0, 1],
  ] as const),
  /** A Ludo token: a chunky cone with a domed top. */
  token: Object.freeze([
    [0, 0],
    [0.42, 0],
    [0.44, 0.08],
    [0.34, 0.3],
    [0.24, 0.55],
    [0.26, 0.7],
    [0.2, 0.86],
    [0, 0.94],
  ] as const),
  /** A pegboard peg: short shaft, rounded cap. */
  peg: Object.freeze([
    [0, 0],
    [0.14, 0],
    [0.14, 0.45],
    [0.3, 0.5],
    [0.32, 0.62],
    [0.24, 0.76],
    [0, 0.8],
  ] as const),
  /** A round bead / marble-like counter. */
  bead: Object.freeze([
    [0, 0],
    [0.22, 0.04],
    [0.4, 0.2],
    [0.46, 0.4],
    [0.4, 0.6],
    [0.22, 0.76],
    [0, 0.8],
  ] as const),
});

/** Options of {@link latheGeometry}. */
export interface LatheOptions {
  /** Radial segments (default: the tier's `latheSegments`). */
  segments?: number;
  /** Spline samples between control points (default: 1 on low, 2 on mid/high; 0 keeps the polyline). */
  subdivisions?: number;
  /** Uniform scale applied to the profile. */
  scale?: number;
  tier?: QualityTier;
}

/**
 * Samples a centripetal Catmull-Rom spline through the profile (endpoints kept, radii clamped
 * to ≥ 0, heights kept non-decreasing so the silhouette never folds back).
 */
export function smoothProfile(points: readonly ProfilePoint[], subdivisions = 3): Vector2[] {
  if (points.length < 2) throw new RangeError("lathe: a profile needs at least 2 points");
  const pts = points.map(([r, y]) => new Vector2(r, y));
  if (subdivisions <= 0) return pts;
  const out: Vector2[] = [];
  const get = (i: number): Vector2 => pts[Math.min(pts.length - 1, Math.max(0, i))] as Vector2;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const steps = subdivisions + 1;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push(new Vector2(Math.max(0, x), y));
    }
  }
  out.push(get(pts.length - 1).clone());
  // Profiles run bottom to top: keep heights non-decreasing so spline overshoot never folds.
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1] as Vector2;
    const cur = out[i] as Vector2;
    if (cur.y < prev.y) cur.y = prev.y;
  }
  return out;
}

/** Builds a lathe geometry from a profile (a named built-in or custom points). */
export function latheGeometry(
  profile: keyof typeof PROFILES | readonly ProfilePoint[],
  o: LatheOptions = {},
): LatheGeometry {
  const pts = typeof profile === "string" ? PROFILES[profile] : profile;
  const segments = Math.max(3, Math.round(o.segments ?? TIERS[o.tier ?? "mid"].latheSegments));
  // Research 04 §3.2: turned pieces ≤ 600 triangles on low, ≤ 1.5k on high.
  const scale = o.scale ?? 1;
  const tier = o.tier ?? "mid";
  const subdivisions = o.subdivisions ?? (tier === "low" ? 1 : 2);
  const curve = smoothProfile(pts, subdivisions).map((p) => p.multiplyScalar(scale));
  // LatheGeometry computes smooth normals itself (including across the seam).
  const geo = new LatheGeometry(curve, segments);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
