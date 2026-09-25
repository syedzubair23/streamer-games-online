/**
 * Rounded boxes (SPEC §13.6: "chunky bevels"): dice, tiles, blocks and props. Built from a box
 * whose grid lines are packed into the corner bands, with every vertex projected onto the
 * rounded surface (inner box + radius × normal), so normals are exact and smooth and the flat
 * faces stay two triangles wide. Low-poly on low tier (2 corner segments), rounder on high.
 *
 * @module
 */
import { BoxGeometry, Vector3 } from "three";
import { TIERS } from "../quality.ts";
import type { QualityTier } from "../types.ts";

/** Options of {@link roundedBoxGeometry}. */
export interface RoundedBoxOptions {
  /** Corner radius (clamped to half the smallest dimension). Default 15% of the smallest side. */
  radius?: number;
  /** Segments per rounded corner (default: the tier's `roundedSegments`). */
  segments?: number;
  tier?: QualityTier;
}

/** Maps a uniform grid coordinate onto the corner bands (`n = 2s + 1` segments per side). */
function packCoord(t: number, half: number, r: number, s: number): number {
  const n = 2 * s + 1;
  const k = ((t / half + 1) * n) / 2; // grid index 0..n (float, exact at vertices)
  if (k <= s) return -half + (r * k) / s;
  if (k >= n - s) return half - (r * (n - k)) / s;
  return -half + r + (half * 2 - 2 * r) * (k - s);
}

/** Builds a rounded box centred on the origin. */
export function roundedBoxGeometry(
  width: number,
  height: number,
  depth: number,
  o: RoundedBoxOptions = {},
): BoxGeometry {
  const s = Math.max(1, Math.round(o.segments ?? TIERS[o.tier ?? "mid"].roundedSegments));
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  const r = Math.max(0, Math.min(o.radius ?? Math.min(width, height, depth) * 0.15, hx, hy, hz));
  const n = 2 * s + 1;
  const geo = new BoxGeometry(width, height, depth, n, n, n);
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const p = new Vector3();
  const inner = new Vector3();
  const dir = new Vector3();
  const ix = hx - r;
  const iy = hy - r;
  const iz = hz - r;
  for (let i = 0; i < pos.count; i++) {
    p.set(
      packCoord(pos.getX(i), hx, r, s),
      packCoord(pos.getY(i), hy, r, s),
      packCoord(pos.getZ(i), hz, r, s),
    );
    inner.set(
      Math.max(-ix, Math.min(ix, p.x)),
      Math.max(-iy, Math.min(iy, p.y)),
      Math.max(-iz, Math.min(iz, p.z)),
    );
    dir.subVectors(p, inner);
    if (r > 0 && dir.lengthSq() > 1e-12) {
      dir.normalize();
      p.copy(inner).addScaledVector(dir, r);
      nrm.setXYZ(i, dir.x, dir.y, dir.z);
    }
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
